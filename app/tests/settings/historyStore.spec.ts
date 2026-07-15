import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HISTORY_ENTRY_LIMIT,
  HistoryStore,
  type HistoryEntry,
} from "../../src/main/history/historyStore.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("HistoryStore", () => {
  it("round-trips text and metrics without persisting extra fields", async () => {
    const store = await createStore();
    const entry = historyEntry(1);
    await store.append({ ...entry, audio: "must-not-persist" } as HistoryEntry);

    expect(await store.read()).toEqual([entry]);
    const line = await readFile(store.filePath, "utf8");
    expect(JSON.parse(line) as Record<string, unknown>).not.toHaveProperty("audio");
    expect(line.endsWith("\n")).toBe(true);
  });

  it("keeps the newest 1000 entries in oldest-first file order", async () => {
    const store = await createStore();
    await Promise.all(
      Array.from({ length: HISTORY_ENTRY_LIMIT + 5 }, (_, index) =>
        store.append(historyEntry(index)),
      ),
    );

    const entries = await store.read();
    expect(entries).toHaveLength(HISTORY_ENTRY_LIMIT);
    expect(entries[0]?.sessionId).toBe("session-5");
    expect(entries.at(-1)?.sessionId).toBe("session-1004");
    expect((await readFile(store.filePath, "utf8")).trim().split("\n")).toHaveLength(
      HISTORY_ENTRY_LIMIT,
    );
  });

  it("clear truncates the JSONL file", async () => {
    const store = await createStore();
    await store.append(historyEntry(1));

    await store.clear();

    expect(await readFile(store.filePath, "utf8")).toBe("");
    expect(await store.read()).toEqual([]);
  });

  it("skips malformed and schema-invalid lines without crashing", async () => {
    const store = await createStore();
    await writeFile(
      store.filePath,
      [
        JSON.stringify(historyEntry(1)),
        "{ definitely-not-json",
        JSON.stringify({ text: "missing fields" }),
        JSON.stringify(historyEntry(2)),
        "",
      ].join("\n"),
    );

    expect(await store.read()).toEqual([historyEntry(1), historyEntry(2)]);
  });

  it("does not create a file when history persistence is disabled", async () => {
    const directory = await temporaryDirectory();
    const store = new HistoryStore({
      userDataPath: directory,
      persistHistory: false,
    });

    await store.append(historyEntry(1));

    await expect(access(store.filePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.read()).toEqual([]);
  });

  it("surfaces filesystem read errors", async () => {
    const store = await createStore();
    await rm(store.filePath, { force: true });
    await import("node:fs/promises").then(({ mkdir }) => mkdir(store.filePath));

    await expect(store.read()).rejects.toMatchObject({ code: expect.any(String) });
  });
});

async function createStore(): Promise<HistoryStore> {
  return new HistoryStore({ userDataPath: await temporaryDirectory() });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wd-history-"));
  temporaryDirectories.push(directory);
  return directory;
}

function historyEntry(index: number): HistoryEntry {
  return {
    sessionId: `session-${index}`,
    text: `nonce transcript ${index}`,
    profile: index % 2 === 0 ? "fast" : "robust",
    completedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    audioDurationMilliseconds: 1_000 + index,
    transcriptionMilliseconds: 100 + index,
    transcriptionMode: index % 2 === 0 ? "server" : "cli",
  };
}
