import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  appPaths,
  type AppConfig,
  type SessionResultPayload,
} from "../../src/core/index.js";
import {
  TranscriptionManager,
  type ListeningProcess,
  type ManagedProcess,
  type ProcessRunOptions,
  type ProcessRunResult,
  type ProcessSpawner,
  type StoppedCapture,
} from "../../src/main/transcription/index.js";
import { FakeWhisperServer } from "../fakes/fake-whisper-server.js";

const managers: TranscriptionManager[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stop()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("whisper-server lifecycle", () => {
  it("spawns, health-checks, and prewarms only configured profiles", async () => {
    const port = await reservePort();
    const nonce = `spawned-${crypto.randomUUID()}`;
    const server = new FakeWhisperServer([{ kind: "transcript", text: nonce }]);
    const spawner = new LifecycleSpawner(server);
    const harness = await lifecycleHarness(port, spawner);

    expect(harness.manager.currentServerState("fast")).toBe("stopped");
    await harness.manager.prewarmServerIfNeeded();

    expect(harness.manager.currentServerState("fast")).toBe("ready");
    expect(harness.manager.currentServerState("robust")).toBe("stopped");
    expect(spawner.spawns).toHaveLength(1);
    expect(spawner.spawns[0]).toMatchObject({
      command: "/fake/whisper-server",
      args: [
        "-m",
        "/models/fast.bin",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "-t",
        "4",
      ],
    });

    harness.manager.enqueue(capture("spawned-server"));
    await waitForResults(harness.results, 1);
    expect(harness.results[0]).toMatchObject({ text: nonce });
  });

  it("terminates an expected stale server before launch", async () => {
    const port = await reservePort();
    const server = new FakeWhisperServer();
    const spawner = new LifecycleSpawner(server, [
      {
        pid: 91,
        command:
          `/fake/whisper-server -m /models/fast.bin --host 127.0.0.1 --port ${port}`,
      },
    ]);
    const harness = await lifecycleHarness(port, spawner);

    await harness.manager.prewarmServerIfNeeded();

    expect(spawner.terminated).toEqual([{ pid: 91, force: false }]);
    expect(spawner.spawns).toHaveLength(1);
    expect(harness.manager.currentServerState("fast")).toBe("ready");
  });

  it("force-kills a stale server and verifies it exited", async () => {
    const port = await reservePort();
    const server = new FakeWhisperServer();
    const spawner = new LifecycleSpawner(
      server,
      [
        {
          pid: 93,
          command:
            `/fake/whisper-server -m /models/fast.bin --port ${port}`,
        },
      ],
      true,
    );
    const harness = await lifecycleHarness(port, spawner);

    await harness.manager.prewarmServerIfNeeded();

    expect(spawner.terminated).toEqual([
      { pid: 93, force: false },
      { pid: 93, force: true },
    ]);
    expect(spawner.processIsRunning(93)).toBe(false);
    expect(harness.manager.currentServerState("fast")).toBe("ready");
  });

  it("refuses to kill an unrelated listener and exposes failure", async () => {
    const port = await reservePort();
    const server = new FakeWhisperServer();
    const spawner = new LifecycleSpawner(server, [
      { pid: 92, command: "python -m http.server" },
    ]);
    const harness = await lifecycleHarness(port, spawner);

    await harness.manager.prewarmServerIfNeeded();

    expect(spawner.terminated).toEqual([]);
    expect(spawner.spawns).toEqual([]);
    expect(harness.manager.currentServerState("fast")).toBe("stopped");
    expect(harness.reportedErrors[0]?.message).toContain(
      `Port ${port} is already used by another process`,
    );
  });

  it("does not accept basename substrings as owned processes", async () => {
    const port = await reservePort();
    const server = new FakeWhisperServer();
    const spawner = new LifecycleSpawner(server, [
      {
        pid: 94,
        command:
          `/fake/whisper-server-evil -m /models/fast.bin.evil --port ${port}`,
      },
    ]);
    const harness = await lifecycleHarness(port, spawner);

    await harness.manager.prewarmServerIfNeeded();

    expect(spawner.terminated).toEqual([]);
    expect(spawner.spawns).toEqual([]);
    expect(harness.manager.currentServerState("fast")).toBe("stopped");
  });

  it("serializes concurrent prewarm and enqueue without double spawn", async () => {
    const port = await reservePort();
    const server = new FakeWhisperServer([
      { kind: "transcript", text: `serialized-${crypto.randomUUID()}` },
    ]);
    const spawner = new LifecycleSpawner(server);
    const harness = await lifecycleHarness(port, spawner);

    const firstPrewarm = harness.manager.prewarmServerIfNeeded();
    const secondPrewarm = harness.manager.prewarmServerIfNeeded();
    harness.manager.enqueue(capture("concurrent-enqueue"));
    await Promise.all([firstPrewarm, secondPrewarm]);
    await waitForResults(harness.results, 1);

    expect(spawner.spawns).toHaveLength(1);
    expect(harness.results).toHaveLength(1);
    expect(harness.manager.currentServerState("fast")).toBe("ready");
  });

  it("does not spawn or relaunch when stop races prewarm and enqueue", async () => {
    const port = await reservePort();
    const server = new FakeWhisperServer();
    const spawner = new LifecycleSpawner(server);
    const harness = await lifecycleHarness(port, spawner);

    const prewarm = harness.manager.prewarmServerIfNeeded();
    harness.manager.enqueue(capture("stop-race"));
    const stop = harness.manager.stop();
    await Promise.all([prewarm, stop]);
    await waitForResults(harness.results, 1);

    expect(spawner.spawns).toHaveLength(0);
    expect(server.isListening).toBe(false);
    expect(harness.manager.currentServerState("fast")).toBe("stopped");
    expect(harness.results[0]?.errorMessage).toBeTypeOf("string");
  });
});

class LifecycleSpawner implements ProcessSpawner {
  readonly spawns: { command: string; args: readonly string[]; logPath: string }[] = [];
  readonly terminated: { pid: number; force: boolean }[] = [];
  private readonly runningPids = new Set<number>();

  constructor(
    private readonly server: FakeWhisperServer,
    private readonly conflicts: ListeningProcess[] = [],
    private readonly ignoreGracefulTermination = false,
  ) {
    conflicts.forEach((process) => this.runningPids.add(process.pid));
  }

  async spawnServer(
    command: string,
    args: readonly string[],
    logPath: string,
  ): Promise<ManagedProcess> {
    this.spawns.push({ command, args: [...args], logPath });
    const portIndex = args.indexOf("--port");
    const port = Number(args[portIndex + 1]);
    await this.server.start(port);
    return new LifecycleManagedProcess(this.server);
  }

  async run(
    _command: string,
    _args: readonly string[],
    _options: ProcessRunOptions,
  ): Promise<ProcessRunResult> {
    return { exitCode: 1, stdout: "", stderr: "unused", timedOut: false };
  }

  async listeningProcesses(_port: number): Promise<ListeningProcess[]> {
    return this.conflicts.filter((process) => this.runningPids.has(process.pid));
  }

  async terminatePid(pid: number, force: boolean): Promise<void> {
    this.terminated.push({ pid, force });
    if (force || !this.ignoreGracefulTermination) {
      this.runningPids.delete(pid);
    }
  }

  processIsRunning(pid: number): boolean {
    return this.runningPids.has(pid);
  }
}

class LifecycleManagedProcess implements ManagedProcess {
  readonly pid = 9_001;
  readonly command = "/fake/whisper-server";
  private running = true;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly server: FakeWhisperServer) {}

  isRunning(): boolean {
    return this.running;
  }

  terminate(): void {
    this.close();
  }

  kill(): void {
    this.close();
  }

  async waitForExit(): Promise<void> {
    await this.closePromise;
  }

  private close(): void {
    if (this.closePromise !== null) {
      return;
    }
    this.running = false;
    this.closePromise = this.server.close();
  }
}

async function lifecycleHarness(
  port: number,
  spawner: ProcessSpawner,
): Promise<{
  manager: TranscriptionManager;
  results: SessionResultPayload[];
  reportedErrors: Error[];
}> {
  const root = await mkdtemp(join(tmpdir(), "whisper-lifecycle-"));
  roots.push(root);
  const config = configFor(root, port);
  const results: SessionResultPayload[] = [];
  const reportedErrors: Error[] = [];
  const manager = new TranscriptionManager({
    config,
    paths: appPaths(config),
    onCompleted: (result) => results.push(result),
    dependencies: {
      processSpawner: spawner,
      errorReporter: (error) => reportedErrors.push(error),
    },
  });
  managers.push(manager);
  return { manager, results, reportedErrors };
}

function configFor(root: string, port: number): AppConfig {
  return {
    controlHost: "127.0.0.1",
    controlPort: 44_124,
    preferredInputDevice: null,
    enforcePreferredInputDevice: false,
    prebufferMilliseconds: 1_000,
    audioBufferSizeFrames: 1_024,
    pollIntervalMilliseconds: 150,
    whisperServerBinary: "/fake/whisper-server",
    whisperCliBinary: "/fake/whisper-cli",
    whisperModelPath: "/models/fast.bin",
    whisperVADModelPath: null,
    whisperServerHost: "127.0.0.1",
    whisperServerPort: port,
    whisperRobustModelPath: "/models/robust.bin",
    robustWhisperServerPort: port + 1,
    tempDirectory: join(root, "tmp"),
    salvageDirectory: join(root, "salvage"),
    daemonLogPath: join(root, "daemon.log"),
    whisperServerLogPath: join(root, "whisper-server.log"),
    controlBinaryPath: "/fake/wdctl",
    daemonBinaryPath: "/fake/daemon",
    warmServerOnLaunch: true,
    warmRobustServerOnLaunch: false,
    whisperThreads: 4,
    persistRecentCaptures: false,
    persistHistory: true,
    serverRequestTimeoutSeconds: 1,
    robustServerRequestTimeoutSeconds: 1,
    cliTimeoutSeconds: 1,
  };
}

function capture(sessionId: string): StoppedCapture {
  const stoppedAt = new Date();
  return {
    sessionId,
    transcriptionProfile: "fast",
    startedAt: new Date(stoppedAt.getTime() - 1_500),
    stoppedAt,
    prebufferMilliseconds: 500,
    samples: new Int16Array(32_000).fill(10),
    signalMetrics: {
      peakDecibels: -10,
      rmsDecibels: -20,
      probablySilent: false,
    },
  };
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return address.port;
}

async function waitForResults(
  results: SessionResultPayload[],
  count: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (results.length < count && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  expect(results).toHaveLength(count);
}
