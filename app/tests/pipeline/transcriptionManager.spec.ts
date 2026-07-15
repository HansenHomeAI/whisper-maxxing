import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  appPaths,
  type AppConfig,
  type SessionResultPayload,
} from "../../src/core/index.js";
import {
  NodeProcessSpawner,
  TranscriptionManager,
  type ListeningProcess,
  type ManagedProcess,
  type ProcessRunOptions,
  type ProcessRunResult,
  type ProcessSpawner,
  type StoppedCapture,
  type TranscriptionManagerDependencies,
} from "../../src/main/transcription/index.js";
import {
  FakeWhisperServer,
  type FakeWhisperScenario,
} from "../fakes/fake-whisper-server.js";

const fakeCliPath = fileURLToPath(
  new URL("../fakes/fake-whisper-cli.mjs", import.meta.url),
);

interface Harness {
  root: string;
  manager: TranscriptionManager;
  results: SessionResultPayload[];
  reportedErrors: Error[];
  processSpawner: FakeServerProcessSpawner;
  cliPidPath: string;
}

const servers: FakeWhisperServer[] = [];
const managers: TranscriptionManager[] = [];
const roots: string[] = [];
const serversByPort = new Map<number, FakeWhisperServer>();

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stop()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  serversByPort.clear();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("TranscriptionManager reliability ladder", () => {
  it("returns a nonce transcript from the real HTTP fake", async () => {
    const nonce = `happy-${crypto.randomUUID()}`;
    const server = await startServer({ kind: "transcript", text: nonce });
    const harness = await createHarness(server);

    harness.manager.enqueue(capture("happy"));
    await waitForResults(harness.results, 1);

    expect(harness.results[0]).toMatchObject({
      sessionId: "happy",
      text: nonce,
      errorMessage: null,
      salvagePath: null,
      metrics: {
        sessionId: "happy",
        transcriptionProfile: "fast",
        transcriptionMode: "server",
        audioDurationMilliseconds: 2_000,
      },
    });
    expect(server.inferenceRequestCount).toBe(1);
    const inference = server.requests.find(
      (request) => request.url === "/inference",
    );
    expect(inference).toBeDefined();
    const riffOffset = inference?.body.indexOf(Buffer.from("RIFF")) ?? -1;
    expect(riffOffset).toBeGreaterThanOrEqual(0);
    expect(inference?.body.subarray(riffOffset + 8, riffOffset + 12).toString("ascii"))
      .toBe("WAVE");
    expect(inference?.body.readUInt32LE(riffOffset + 4)).toBe(44 + 64_000 - 8);
    expect(harness.manager.currentServerState("fast")).toBe("ready");
    expect(harness.manager.currentServerState("robust")).toBe("stopped");
  });

  it("bounds server timeouts and falls back to the CLI", async () => {
    const nonce = `cli-timeout-${crypto.randomUUID()}`;
    const server = await startServer({ kind: "hang" }, { kind: "hang" });
    const harness = await createHarness(
      server,
      { serverRequestTimeoutSeconds: 0.05 },
      [{ kind: "transcript", text: nonce }],
    );

    harness.manager.enqueue(capture("timeout"));
    await waitForResults(harness.results, 1);

    expect(harness.results[0]).toMatchObject({
      sessionId: "timeout",
      text: nonce,
      errorMessage: null,
      metrics: { transcriptionMode: "cli" },
    });
    expect(server.inferenceRequestCount).toBe(2);
    expect(harness.manager.currentServerState("fast")).toBe("ready");
  });

  it("keeps the timeout active while reading a stalled response body", async () => {
    const nonce = `cli-body-timeout-${crypto.randomUUID()}`;
    const server = await startServer(
      { kind: "headers-then-hang" },
      { kind: "headers-then-hang" },
    );
    const harness = await createHarness(
      server,
      { serverRequestTimeoutSeconds: 0.05 },
      [{ kind: "transcript", text: nonce }],
    );

    harness.manager.enqueue(capture("body-timeout"));
    await waitForResults(harness.results, 1);

    expect(harness.results[0]).toMatchObject({
      text: nonce,
      errorMessage: null,
      metrics: { transcriptionMode: "cli" },
    });
    expect(server.inferenceRequestCount).toBe(2);
  });

  it("falls back after refused server connections", async () => {
    const nonce = `cli-refused-${crypto.randomUUID()}`;
    const server = await startServer(
      { kind: "refuse-connection" },
      { kind: "refuse-connection" },
    );
    const harness = await createHarness(server, {}, [
      { kind: "transcript", text: nonce },
    ]);

    harness.manager.enqueue(capture("refused"));
    await waitForResults(harness.results, 1);

    expect(harness.results[0]?.text).toBe(nonce);
    expect(harness.results[0]?.metrics.transcriptionMode).toBe("cli");
  });

  it("never sends audio to an unowned healthy HTTP listener", async () => {
    const serverNonce = `unowned-${crypto.randomUUID()}`;
    const cliNonce = `safe-cli-${crypto.randomUUID()}`;
    const server = await startServer({
      kind: "transcript",
      text: serverNonce,
    });
    const unowned = new UnownedHealthyProcessSpawner();
    const harness = await createHarness(
      server,
      {},
      [{ kind: "transcript", text: cliNonce }],
      { processSpawner: unowned },
    );

    harness.manager.enqueue(capture("unowned-listener"));
    await waitForResults(harness.results, 1);

    expect(server.inferenceRequestCount).toBe(0);
    expect(unowned.terminated).toBe(false);
    expect(harness.results[0]).toMatchObject({
      text: cliNonce,
      metrics: { transcriptionMode: "cli" },
    });
  });

  it("surfaces combined failure and persists salvage WAV", async () => {
    const server = await startServer(
      { kind: "http-error", status: 503 },
      { kind: "http-error", status: 503 },
    );
    const harness = await createHarness(server, {}, [
      { kind: "error", message: "nonce-cli-failure" },
    ]);

    harness.manager.enqueue(capture("both-fail"));
    await waitForResults(harness.results, 1);

    const result = requiredResult(harness.results, 0);
    expect(result.text).toBe("");
    expect(result.errorMessage).toContain("Server failed:");
    expect(result.errorMessage).toContain("nonce-cli-failure");
    expect(result.metrics.transcriptionMode).toBe("failed");
    expect(result.salvagePath).toBeTypeOf("string");
    const wav = await readFile(result.salvagePath as string);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.length).toBe(44 + 32_000 * 2);
  });

  it("bounds a hung CLI and returns an explicit error result", async () => {
    const server = await startServer(
      { kind: "http-error", status: 500 },
      { kind: "http-error", status: 500 },
    );
    const harness = await createHarness(
      server,
      { cliTimeoutSeconds: 0.05 },
      [{ kind: "hang" }],
    );

    harness.manager.enqueue(capture("cli-hang"));
    await waitForResults(harness.results, 1);

    const result = requiredResult(harness.results, 0);
    expect(result.errorMessage).toContain("whisper-cli timed out after 0 seconds");
    expect(result.metrics.transcriptionMode).toBe("failed");
    expect(result.salvagePath).toBeTypeOf("string");
    const cliPid = Number(await readFile(harness.cliPidPath, "utf8"));
    expect(processIsRunning(cliPid)).toBe(false);
    await expect(
      readFile(join(harness.root, "tmp", "cli-hang.wav")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains WAV when timed-out CLI termination is unconfirmed", async () => {
    const server = await startServer(
      { kind: "http-error", status: 500 },
      { kind: "http-error", status: 500 },
    );
    const config = makeConfig(tmpdir(), server.port, {});
    const orderingSpawner = new UnconfirmedTimeoutSpawner(config);
    const harness = await createHarness(server, {}, [], {
      processSpawner: orderingSpawner,
    });

    harness.manager.enqueue(capture("unconfirmed-cli"));
    await waitForResults(harness.results, 1);

    expect(orderingSpawner.wavExistedBeforeReturn).toBe(true);
    const retained = join(harness.root, "tmp", "unconfirmed-cli.wav");
    expect((await readFile(retained).then((data) => data.subarray(0, 4).toString("ascii"))))
      .toBe("RIFF");
    expect(harness.results[0]?.errorMessage).toContain(
      "could not be terminated; WAV retained",
    );
  });

  it("uses the quality-gated CLI second pass result", async () => {
    const nonce = `second-pass-${crypto.randomUUID()}`;
    const good = `${nonce} ${"reliable transcription words ".repeat(5)}`;
    const server = await startServer({ kind: "transcript", text: "tiny" });
    const harness = await createHarness(server, {}, [
      { kind: "transcript", text: good },
    ]);

    harness.manager.enqueue(longCapture("quality-pass"));
    await waitForResults(harness.results, 1);

    expect(harness.results[0]).toMatchObject({
      sessionId: "quality-pass",
      text: good.trim(),
      errorMessage: null,
      metrics: { transcriptionMode: "cli-second-pass" },
    });
  });

  it("salvages a second pass that remains low confidence", async () => {
    const nonce = crypto.randomUUID().slice(0, 6);
    const serverText = `server-${nonce}`;
    const cliText = `cli-${nonce}`;
    const server = await startServer({ kind: "transcript", text: serverText });
    const harness = await createHarness(server, {}, [
      { kind: "transcript", text: cliText },
    ]);

    harness.manager.enqueue(longCapture("quality-fail"));
    await waitForResults(harness.results, 1);

    const result = requiredResult(harness.results, 0);
    expect(result.text).toBe("");
    expect(result.errorMessage).toBe(
      "Low-confidence dictation. Audio saved for review.",
    );
    expect(result.salvagePath).toBeTypeOf("string");
    const diagnostics = await diagnosticFor(result.salvagePath as string);
    expect(diagnostics).toMatchObject({
      reason: "long-audio-short-transcript",
      sessionId: "quality-fail",
      cleanedTranscript: cliText,
    });
    expect(String(diagnostics.rawTranscript)).toContain(serverText);
    expect(String(diagnostics.rawTranscript)).toContain(cliText);
  });

  it("rejects incomplete capture before making inference calls", async () => {
    const server = await startServer({
      kind: "transcript",
      text: `must-not-run-${crypto.randomUUID()}`,
    });
    const harness = await createHarness(server);

    harness.manager.enqueue(stalledCapture("stalled"));
    await waitForResults(harness.results, 1);

    const result = requiredResult(harness.results, 0);
    expect(server.inferenceRequestCount).toBe(0);
    expect(result.errorMessage).toContain("capture-stalled");
    expect(result.salvagePath).toBeTypeOf("string");
    const diagnostics = await diagnosticFor(result.salvagePath as string);
    expect(diagnostics).toMatchObject({
      reason: "capture-stalled",
      sessionId: "stalled",
    });
  });

  it("reports capture-duration-gap for partial long captures", async () => {
    const server = await startServer({
      kind: "transcript",
      text: `must-not-run-${crypto.randomUUID()}`,
    });
    const harness = await createHarness(server);
    const partial = longCapture("duration-gap");
    partial.samples = samples(80_000);

    harness.manager.enqueue(partial);
    await waitForResults(harness.results, 1);

    const result = requiredResult(harness.results, 0);
    expect(server.inferenceRequestCount).toBe(0);
    expect(result.errorMessage).toContain("capture-duration-gap");
    expect(await diagnosticFor(result.salvagePath as string)).toMatchObject({
      reason: "capture-duration-gap",
    });
  });

  it("re-enqueues the retained audio with the robust profile", async () => {
    const fastNonce = `fast-${crypto.randomUUID()}`;
    const robustNonce = `robust-${crypto.randomUUID()}`;
    const fastServer = await startServer({ kind: "transcript", text: fastNonce });
    const robustServer = await startServer({
      kind: "transcript",
      text: robustNonce,
    });
    const harness = await createHarness(fastServer, {
      robustWhisperServerPort: robustServer.port,
      whisperRobustModelPath: "/models/robust.bin",
    });

    harness.manager.enqueue(capture("original"));
    await waitForResults(harness.results, 1);
    const retrySessionId = harness.manager.enqueueRobustRetry();
    await waitForResults(harness.results, 2);

    expect(retrySessionId).not.toBe("original");
    expect(harness.results.map((result) => result.text)).toEqual([
      fastNonce,
      robustNonce,
    ]);
    expect(harness.results[1]).toMatchObject({
      sessionId: retrySessionId,
      metrics: {
        transcriptionProfile: "robust",
        transcriptionMode: "robust-server",
      },
    });
    expect(robustServer.inferenceRequestCount).toBe(1);
    expect(harness.processSpawner.spawns).toEqual([
      { port: fastServer.port, modelPath: "/models/fast.bin" },
      { port: robustServer.port, modelPath: "/models/robust.bin" },
    ]);
  });

  it("uses the robust model for robust CLI fallback", async () => {
    const fastServer = await startServer({
      kind: "transcript",
      text: `fast-${crypto.randomUUID()}`,
    });
    const robustServer = await startServer(
      { kind: "http-error", status: 500 },
      { kind: "http-error", status: 500 },
    );
    const robustNonce = `robust-cli-${crypto.randomUUID()}`;
    const harness = await createHarness(
      fastServer,
      {
        robustWhisperServerPort: robustServer.port,
        whisperRobustModelPath: "/models/robust.bin",
      },
      [
        {
          kind: "transcript",
          text: robustNonce,
          expectedModel: "/models/robust.bin",
        },
      ],
    );

    harness.manager.enqueue(capture("robust-cli-source"));
    await waitForResults(harness.results, 1);
    const retryId = harness.manager.enqueueRobustRetry();
    await waitForResults(harness.results, 2);

    expect(harness.results[1]).toMatchObject({
      sessionId: retryId,
      text: robustNonce,
      errorMessage: null,
      metrics: {
        transcriptionProfile: "robust",
        transcriptionMode: "robust-cli",
      },
    });
    expect(harness.processSpawner.spawns).toContainEqual({
      port: robustServer.port,
      modelPath: "/models/robust.bin",
    });
  });

  it("reports an unconfigured robust model clearly", async () => {
    const server = await startServer({
      kind: "transcript",
      text: `fast-only-${crypto.randomUUID()}`,
    });
    const harness = await createHarness(server, {
      whisperRobustModelPath: null,
    });

    harness.manager.enqueue(capture("fast-only"));
    await waitForResults(harness.results, 1);

    expect(() => harness.manager.enqueueRobustRetry()).toThrow(
      "Robust dictation model is not configured. Reinstall with WHISPER_ROBUST_MODEL_PATH.",
    );
    expect(harness.manager.pendingCount()).toBe(0);
  });

  it("delivers queued sessions in order exactly once", async () => {
    const nonces = Array.from(
      { length: 8 },
      (_, index) => `queue-${index}-${crypto.randomUUID()}`,
    );
    const server = await startServer(
      ...nonces.map((text) => ({ kind: "transcript", text }) as const),
    );
    const harness = await createHarness(server);

    nonces.forEach((_, index) =>
      harness.manager.enqueue(capture(`queued-${index}`)),
    );
    expect(harness.manager.pendingCount()).toBe(nonces.length);
    await waitForResults(harness.results, nonces.length);

    expect(harness.results.map((result) => result.sessionId)).toEqual(
      nonces.map((_, index) => `queued-${index}`),
    );
    expect(harness.results.map((result) => result.text)).toEqual(nonces);
    expect(new Set(harness.results.map((result) => result.sessionId)).size).toBe(
      nonces.length,
    );
    expect(harness.manager.pendingCount()).toBe(0);
  });

  it("runs CLI after a no-speech server result", async () => {
    const nonce = `no-speech-cli-${crypto.randomUUID()}`;
    const server = await startServer({ kind: "no-speech" });
    const harness = await createHarness(server, {}, [
      { kind: "transcript", text: nonce },
    ]);

    harness.manager.enqueue(capture("no-speech"));
    await waitForResults(harness.results, 1);

    expect(harness.results[0]).toMatchObject({
      text: nonce,
      errorMessage: null,
      metrics: { transcriptionMode: "cli" },
    });
  });

  it("surfaces no-speech CLI failure with salvage", async () => {
    const server = await startServer({ kind: "no-speech" });
    const harness = await createHarness(server, {}, [
      { kind: "error", message: "no-speech-cli-failed" },
    ]);

    harness.manager.enqueue(capture("no-speech-cli-failure"));
    await waitForResults(harness.results, 1);

    const result = requiredResult(harness.results, 0);
    expect(result.errorMessage).toContain(
      "CLI fallback after no-speech result failed",
    );
    expect(result.errorMessage).toContain("no-speech-cli-failed");
    expect(result.salvagePath).toBeTypeOf("string");
    expect(result.metrics.transcriptionMode).toBe("failed");
  });

  it("maps critical disk failures to Disk Almost Full", async () => {
    const server = await startServer(
      { kind: "http-error", status: 500 },
      { kind: "http-error", status: 500 },
    );
    const harness = await createHarness(
      server,
      {},
      [{ kind: "error", message: "ordinary CLI failure" }],
      {
        diskStatusProvider: () => ({
          availableBytes: 180 * 1024 * 1024,
          lowSpace: true,
          criticalSpace: true,
          summary: "180 MB",
        }),
      },
    );

    harness.manager.enqueue(capture("critical-disk"));
    await waitForResults(harness.results, 1);

    expect(harness.results[0]?.errorMessage).toBe(
      "Disk Almost Full (180 MB free)",
    );
  });

  it("maps ENOSPC failures to Disk Almost Full", async () => {
    const server = await startServer(
      { kind: "http-error", status: 500 },
      { kind: "http-error", status: 500 },
    );
    const harness = await createHarness(
      server,
      {},
      [{ kind: "error", message: "ENOSPC: no space left on device" }],
      {
        diskStatusProvider: () => ({
          availableBytes: 2_000_000_000,
          lowSpace: false,
          criticalSpace: false,
          summary: "2 GB",
        }),
      },
    );

    harness.manager.enqueue(capture("enospc"));
    await waitForResults(harness.results, 1);

    expect(harness.results[0]?.errorMessage).toBe(
      "Disk Almost Full (2 GB free)",
    );
  });

  it("does not run no-speech CLI fallback at critical disk level", async () => {
    const server = await startServer({ kind: "no-speech" });
    const harness = await createHarness(
      server,
      {},
      [{ kind: "error", message: "must-not-run" }],
      {
        diskStatusProvider: () => ({
          availableBytes: 100,
          lowSpace: true,
          criticalSpace: true,
          summary: "100 bytes",
        }),
      },
    );

    harness.manager.enqueue(capture("critical-no-speech"));
    await waitForResults(harness.results, 1);

    expect(harness.results[0]).toMatchObject({
      text: "",
      errorMessage: null,
      metrics: { transcriptionMode: "no-speech" },
    });
  });

  it("persists successful audio only when explicitly enabled", async () => {
    const nonce = `recent-${crypto.randomUUID()}`;
    const server = await startServer({ kind: "transcript", text: nonce });
    const harness = await createHarness(server, { persistRecentCaptures: true });

    harness.manager.enqueue(capture("recent"));
    await waitForResults(harness.results, 1);

    const recentDirectory = join(harness.root, "salvage", "recent");
    const files = await readdir(recentDirectory);
    expect(files.filter((file) => file.endsWith(".wav"))).toHaveLength(1);
    expect(files.filter((file) => file.endsWith(".json"))).toHaveLength(1);
    const metadataPath = join(
      recentDirectory,
      files.find((file) => file.endsWith(".json")) as string,
    );
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
      text: string;
      sessionId: string;
    };
    expect(metadata).toMatchObject({ text: nonce, sessionId: "recent" });
  });

  it("salvages cleaned text when placeholder artifacts are stripped", async () => {
    const nonce = `artifact-${crypto.randomUUID()}`;
    const server = await startServer({
      kind: "transcript",
      text: `[BLANK_AUDIO] ${nonce} [NO_SPEECH]`,
    });
    const harness = await createHarness(server);

    harness.manager.enqueue(capture("artifact"));
    await waitForResults(harness.results, 1);

    const result = requiredResult(harness.results, 0);
    expect(result.text).toBe(nonce);
    expect(result.salvagePath).toBeTypeOf("string");
    expect(await diagnosticFor(result.salvagePath as string)).toMatchObject({
      reason: "inline-placeholder-artifacts",
      cleanedTranscript: nonce,
    });
  });

  it("checks VAD readability without reading model contents", async () => {
    const server = await startServer({
      kind: "transcript",
      text: `vad-${crypto.randomUUID()} ${"readability verified ".repeat(20)}`,
    });
    const root = await mkdtemp(join(tmpdir(), "whisper-vad-model-"));
    roots.push(root);
    const readableWithoutFileContents = join(root, "vad-model-directory");
    await mkdir(readableWithoutFileContents);
    const harness = await createHarness(server, {
      whisperVADModelPath: readableWithoutFileContents,
    });

    harness.manager.enqueue(vadCapture("vad-readability"));
    await waitForResults(harness.results, 1);

    expect(harness.results[0]?.errorMessage).toBeNull();
    const inference = server.requests.find(
      (request) => request.url === "/inference",
    );
    const multipart = inference?.body.toString("latin1") ?? "";
    expect(multipart).toContain('name="vad"');
    expect(multipart).toContain('name="vad_min_silence_duration_ms"');
  });
});

async function startServer(
  ...scenarios: FakeWhisperScenario[]
): Promise<FakeWhisperServer> {
  const server = new FakeWhisperServer(scenarios);
  await server.start();
  servers.push(server);
  serversByPort.set(server.port, server);
  return server;
}

async function createHarness(
  server: FakeWhisperServer,
  overrides: Partial<AppConfig> = {},
  cliScenarios: unknown[] = [],
  dependencies: TranscriptionManagerDependencies = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "whisper-pipeline-"));
  roots.push(root);
  const cliScenarioPath = join(root, "cli-scenarios.json");
  const cliPidPath = join(root, "cli.pid");
  await writeFile(cliScenarioPath, `${JSON.stringify(cliScenarios)}\n`, "utf8");
  const config = makeConfig(root, server.port, overrides);
  const results: SessionResultPayload[] = [];
  const reportedErrors: Error[] = [];
  const processSpawner = new FakeServerProcessSpawner(config);
  const manager = new TranscriptionManager({
    config,
    paths: appPaths(config),
    onCompleted: (result) => results.push(result),
    dependencies: {
      cliEnvironment: {
        ...process.env,
        FAKE_WHISPER_CLI_SCENARIO_FILE: cliScenarioPath,
        FAKE_WHISPER_CLI_EXPECTED_MODEL: "/models/fast.bin",
        FAKE_WHISPER_CLI_PID_FILE: cliPidPath,
      },
      processSpawner,
      errorReporter: (error) => reportedErrors.push(error),
      ...dependencies,
    },
  });
  managers.push(manager);
  return {
    root,
    manager,
    results,
    reportedErrors,
    processSpawner,
    cliPidPath,
  };
}

class FakeServerProcessSpawner implements ProcessSpawner {
  private readonly delegate = new NodeProcessSpawner();
  readonly spawns: { port: number; modelPath: string }[] = [];

  constructor(private readonly config: AppConfig) {}

  async spawnServer(
    _command: string,
    args: readonly string[],
    _logPath: string,
  ): Promise<ManagedProcess> {
    const portIndex = args.indexOf("--port");
    const port = Number(args[portIndex + 1]);
    const modelIndex = args.indexOf("-m");
    const modelPath = args[modelIndex + 1];
    const expectedModel =
      port === this.config.whisperServerPort
        ? this.config.whisperModelPath
        : this.config.whisperRobustModelPath;
    if (modelPath !== expectedModel) {
      throw new Error(
        `Unexpected model for fake server port ${port}: ${modelPath}`,
      );
    }
    this.spawns.push({ port, modelPath });
    const server = serversByPort.get(port);
    if (server === undefined) {
      throw new Error(`No fake whisper server registered on port ${port}`);
    }
    await server.start(port);
    return new FakeServerManagedProcess(server, processId(port));
  }

  async run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions,
  ): Promise<ProcessRunResult> {
    return this.delegate.run(command, args, options);
  }

  async listeningProcesses(port: number): Promise<ListeningProcess[]> {
    const server = serversByPort.get(port);
    if (server?.isListening !== true) {
      return [];
    }
    const model =
      port === this.config.whisperServerPort
        ? this.config.whisperModelPath
        : this.config.whisperRobustModelPath;
    return [
      {
        pid: processId(port),
        command:
          `${this.config.whisperServerBinary} -m ${model} ` +
          `--host ${this.config.whisperServerHost} --port ${port}`,
      },
    ];
  }

  async terminatePid(pid: number, _force: boolean): Promise<void> {
    const server = serversByPort.get(portFromProcessId(pid));
    await server?.close();
  }

  processIsRunning(pid: number): boolean {
    return serversByPort.get(portFromProcessId(pid))?.isListening === true;
  }
}

class UnownedHealthyProcessSpawner implements ProcessSpawner {
  private readonly delegate = new NodeProcessSpawner();
  terminated = false;

  async spawnServer(): Promise<ManagedProcess> {
    throw new Error("An unowned listener must prevent server launch");
  }

  async run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions,
  ): Promise<ProcessRunResult> {
    return this.delegate.run(command, args, options);
  }

  async listeningProcesses(_port: number): Promise<ListeningProcess[]> {
    return [{ pid: 77, command: "node unrelated-health-service.mjs" }];
  }

  async terminatePid(): Promise<void> {
    this.terminated = true;
  }

  processIsRunning(): boolean {
    return true;
  }
}

class UnconfirmedTimeoutSpawner extends FakeServerProcessSpawner {
  wavExistedBeforeReturn = false;

  override async run(
    _command: string,
    args: readonly string[],
    _options: ProcessRunOptions,
  ): Promise<ProcessRunResult> {
    const wavIndex = args.indexOf("-f");
    const wavPath = args[wavIndex + 1];
    if (wavPath !== undefined) {
      const wav = await readFile(wavPath);
      this.wavExistedBeforeReturn =
        wav.subarray(0, 4).toString("ascii") === "RIFF";
    }
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: true,
      terminationConfirmed: false,
    };
  }
}

class FakeServerManagedProcess implements ManagedProcess {
  readonly command = "/unused/whisper-server";
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly server: FakeWhisperServer,
    readonly pid: number,
  ) {}

  isRunning(): boolean {
    return this.server.isListening;
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
    this.closePromise ??= this.server.close();
  }
}

function processId(port: number): number {
  return 100_000 + port;
}

function portFromProcessId(pid: number): number {
  return pid - 100_000;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function makeConfig(
  root: string,
  serverPort: number,
  overrides: Partial<AppConfig>,
): AppConfig {
  return {
    controlHost: "127.0.0.1",
    controlPort: 44_124,
    preferredInputDevice: null,
    enforcePreferredInputDevice: false,
    prebufferMilliseconds: 1_000,
    audioBufferSizeFrames: 1_024,
    pollIntervalMilliseconds: 150,
    whisperServerBinary: "/unused/whisper-server",
    whisperCliBinary: fakeCliPath,
    whisperModelPath: "/models/fast.bin",
    whisperVADModelPath: null,
    whisperServerHost: "127.0.0.1",
    whisperServerPort: serverPort,
    whisperRobustModelPath: "/models/robust.bin",
    robustWhisperServerPort: serverPort,
    tempDirectory: join(root, "tmp"),
    salvageDirectory: join(root, "salvage"),
    daemonLogPath: join(root, "daemon.log"),
    whisperServerLogPath: join(root, "whisper-server.log"),
    controlBinaryPath: "/unused/wdctl",
    daemonBinaryPath: "/unused/daemon",
    warmServerOnLaunch: true,
    warmRobustServerOnLaunch: false,
    whisperThreads: 4,
    persistRecentCaptures: false,
    persistHistory: true,
    serverRequestTimeoutSeconds: 1,
    robustServerRequestTimeoutSeconds: 1,
    cliTimeoutSeconds: 1,
    ...overrides,
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
    samples: samples(32_000),
    signalMetrics: {
      peakDecibels: -10,
      rmsDecibels: -20,
      probablySilent: false,
    },
  };
}

function longCapture(sessionId: string): StoppedCapture {
  const stoppedAt = new Date();
  return {
    ...capture(sessionId),
    startedAt: new Date(stoppedAt.getTime() - 10_000),
    stoppedAt,
    prebufferMilliseconds: 0,
    samples: samples(160_000),
  };
}

function stalledCapture(sessionId: string): StoppedCapture {
  const stoppedAt = new Date();
  return {
    ...capture(sessionId),
    startedAt: new Date(stoppedAt.getTime() - 2_000),
    stoppedAt,
    prebufferMilliseconds: 0,
    samples: samples(1_600),
  };
}

function vadCapture(sessionId: string): StoppedCapture {
  const stoppedAt = new Date();
  return {
    ...capture(sessionId),
    startedAt: new Date(stoppedAt.getTime() - 15_000),
    stoppedAt,
    prebufferMilliseconds: 0,
    samples: samples(240_000),
  };
}

function samples(count: number): Int16Array {
  const output = new Int16Array(count);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = (index % 101) - 50;
  }
  return output;
}

async function waitForResults(
  results: SessionResultPayload[],
  count: number,
): Promise<void> {
  const deadline = Date.now() + 7_000;
  while (results.length < count && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  expect(results, `expected ${count} results before timeout`).toHaveLength(count);
}

function requiredResult(
  results: SessionResultPayload[],
  index: number,
): SessionResultPayload {
  const result = results[index];
  if (result === undefined) {
    throw new Error(`Missing result at index ${index}`);
  }
  return result;
}

async function diagnosticFor(
  salvagePath: string,
): Promise<Record<string, unknown>> {
  const directory = dirname(salvagePath);
  const prefix = salvagePath.slice(0, -4);
  return JSON.parse(
    await readFile(`${prefix}-diagnostics.json`, "utf8"),
  ) as Record<string, unknown>;
}
