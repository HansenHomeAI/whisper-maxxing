import { appendFile, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LocalDiagnostics,
  RecoveryStore,
} from "../../src/main/reliability/index.js";

describe("local reliability storage", () => {
  let root: string;
  let diagnostics: LocalDiagnostics;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "whisper-reliability-"));
    diagnostics = new LocalDiagnostics(
      join(root, "diagnostics"),
      "test-process",
      true,
      [root],
    );
    await diagnostics.initialize();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  it("keeps one valid WAV until delivery is acknowledged", async () => {
    const store = await createStore();
    const spool = await store.createSpool(
      "session-one",
      "fast",
      new Date("2026-07-20T12:00:00Z"),
      Int16Array.from([1, -2, 3]),
    );
    expect(spool).not.toBeNull();
    spool!.append(Int16Array.from([4, 5, -6]));
    const finalized = await spool!.finalize(new Date("2026-07-20T12:00:02Z"));
    await store.awaitingDelivery("session-one");

    const wav = await readFile(finalized.wavPath);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(40)).toBe(12);
    expect(wav.byteLength).toBe(56);
    expect((await store.list())[0]).toMatchObject({
      sessionId: "session-one",
      state: "awaiting_delivery",
      sampleCount: 6,
    });

    vi.useFakeTimers();
    await store.acknowledge("session-one", "delivered");
    expect(await store.list()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await store.list()).toEqual([]);
    vi.useRealTimers();
  });

  it("retains failed delivery for export with private permissions", async () => {
    const store = await createStore();
    const spool = await store.createSpool(
      "session-two",
      "robust",
      new Date("2026-07-20T12:00:00Z"),
      new Int16Array(160),
    );
    const finalized = await spool!.finalize(new Date("2026-07-20T12:00:01Z"));
    await store.acknowledge("session-two", "pasteFailed");
    const destination = join(root, "export.wav");
    await store.export("session-two", destination);

    expect((await readFile(destination)).equals(await readFile(finalized.wavPath))).toBe(true);
    expect((await store.list())[0]).toMatchObject({
      state: "retained",
      reason: "pasteFailed",
    });
    if (process.platform !== "win32") {
      expect((await stat(finalized.wavPath)).mode & 0o077).toBe(0);
    }
  });

  it("repairs an abandoned aligned partial WAV exactly once", async () => {
    const directory = join(root, "recovery");
    const seedStore = await createStore();
    const spool = await seedStore.createSpool(
      "session-three",
      "fast",
      new Date("2026-07-20T12:00:00Z"),
      Int16Array.from([10, 20, 30, 40]),
    );
    const finalized = await spool!.finalize(new Date("2026-07-20T12:00:01Z"));
    const part = join(directory, "session-three.wav.part");
    await rename(finalized.wavPath, part);
    await appendFile(part, Buffer.from([99]));

    // Model a fresh process by reconstructing the store over the abandoned files.
    const recovered = new RecoveryStore({
      directory,
      enabled: true,
      diagnostics,
      persistRecentCaptures: false,
    });
    await recovered.initialize();
    const entries = await recovered.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sessionId: "session-three",
      state: "retained",
      reason: "interrupted",
      sampleCount: 4,
    });
    expect((await readFile(entries[0]!.wavPath)).readUInt32LE(40)).toBe(8);
  });

  it("scrubs local paths and tolerates a torn journal line", async () => {
    diagnostics.record({
      severity: "error",
      component: "capture",
      event: "write failed",
      sessionId: "session-four",
      message: `unable to write ${root}/secret.wav\nnext line`,
    });
    await diagnostics.flush();
    const file = join(root, "diagnostics", `diagnostics-${new Date().toISOString().slice(0, 10)}.jsonl`);
    await appendFile(file, "{torn");
    const records = await diagnostics.records();

    expect(records).toHaveLength(1);
    expect(records[0]?.message).toContain("<LOCAL_PATH>");
    expect(records[0]?.message).not.toContain(root);
    expect(records[0]?.event).toBe("write_failed");
  });

  async function createStore(): Promise<RecoveryStore> {
    const store = new RecoveryStore({
      directory: join(root, "recovery"),
      enabled: true,
      diagnostics,
      persistRecentCaptures: false,
    });
    await store.initialize();
    return store;
  }
});
