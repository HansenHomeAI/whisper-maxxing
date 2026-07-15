import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CaptureEngine,
  CaptureEngineError,
  type CaptureEngineOptions,
  type CaptureFileSystem,
} from "../../src/main/capture/captureEngine.js";
import { restartElectronApplication } from "../../src/main/capture/electronRestart.js";
import {
  FakeCaptureClock,
  FakeCaptureSource,
  parseMonoPcm16Wav,
} from "../fakes/fake-capture-source.js";

const fixturePath = fileURLToPath(
  new URL("../fixtures/audio/prebuffer-marker.wav", import.meta.url),
);

describe("CaptureEngine", () => {
  let directory: string;
  let clock: FakeCaptureClock;
  let source: FakeCaptureSource;
  let engine: CaptureEngine;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "whisper-capture-test-"));
    clock = new FakeCaptureClock();
    source = new FakeCaptureSource({
      wavPath: fixturePath,
      clock,
      frameSamples: 1_600,
    });
    engine = createEngine(source, clock, directory);
  });

  afterEach(async () => {
    await engine.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  it("prepends the exact rolling prebuffer bytes to the capture", async () => {
    await startEngineAndFeedFrames(engine, source, clock, 10);
    const fixture = parseMonoPcm16Wav(await readFile(fixturePath));
    const started = engine.startSession("fast");
    expect(started.prebufferMilliseconds).toBe(1_000);

    feedFrames(source, clock, 5);
    const capture = await engine.stopSession(false);
    expect(capture).not.toBeNull();
    const output = parseMonoPcm16Wav(await readFile(capture!.wavPath));

    expect(Array.from(output.samples.subarray(0, 16_000))).toEqual(
      Array.from(fixture.samples.subarray(0, 16_000)),
    );
    expect(Array.from(output.samples.subarray(8_000, 16_000))).toEqual(
      Array.from(fixture.samples.subarray(8_000, 16_000)),
    );
    expect(output.samples.some((sample) => sample !== 0)).toBe(true);
  });

  it("returns exact duration and coverage metrics", async () => {
    await startEngineAndFeedFrames(engine, source, clock, 10);
    engine.startSession("robust");
    feedFrames(source, clock, 5);

    const capture = await engine.stopSession(false);
    expect(capture).toMatchObject({
      transcriptionProfile: "robust",
      prebufferMilliseconds: 1_000,
      sampleCount: 24_000,
      audioDurationMilliseconds: 1_500,
      wallClockMilliseconds: 500,
      activeAudioMilliseconds: 500,
      droppedMilliseconds: 0,
    });
    expect(capture!.startedAt.getUTCFullYear()).toBe(2026);
    expect(capture!.stoppedAt.getUTCFullYear()).toBe(2026);
    expect(capture!.signalMetrics.probablySilent).toBe(false);
  });

  it("uses wall dates for coverage when monotonic and wall clocks diverge", async () => {
    let wallTime = Date.UTC(2026, 5, 1, 12, 0, 0);
    engine = createEngine(source, clock, directory, undefined, {
      dateClock: { nowDate: () => new Date(wallTime) },
    });
    await startEngineAndFeedFrames(engine, source, clock, 10);
    engine.startSession("fast");
    feedFrames(source, clock, 5);
    wallTime += 750;

    const capture = await engine.stopSession(false);

    expect(capture).toMatchObject({
      wallClockMilliseconds: 750,
      activeAudioMilliseconds: 500,
      droppedMilliseconds: 250,
    });
    expect(capture!.stoppedAt.getTime() - capture!.startedAt.getTime()).toBe(
      750,
    );
  });

  it("discards without creating a WAV file", async () => {
    await startEngineAndFeedFrames(engine, source, clock, 1);
    engine.startSession("fast");
    feedFrames(source, clock, 1);

    await expect(engine.stopSession(true)).resolves.toBeNull();
    expect(await readdir(directory)).toEqual([]);
    expect(engine.isRecording()).toBe(false);
  });

  it("writes a valid 16 kHz mono s16le WAV header and PCM body", async () => {
    await startEngineAndFeedFrames(engine, source, clock, 1);
    engine.startSession("fast");
    feedFrames(source, clock, 1);
    const capture = await engine.stopSession(false);
    const wav = await readFile(capture!.wavPath);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.subarray(12, 16).toString()).toBe("fmt ");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(wav.subarray(36, 40).toString()).toBe("data");
    expect(view.getUint32(40, true)).toBe(wav.byteLength - 44);
    expect(parseMonoPcm16Wav(wav).samples.length).toBe(3_200);
  });

  it("detects a stale feed and escalates after three restart failures", async () => {
    const restartActions: string[] = [];
    engine = createEngine(source, clock, directory, () => {
      restartActions.push("restartProcess");
    });
    await startEngineAndFeedFrames(engine, source, clock, 1);
    source.queueStartFailures(
      new Error("restart one failed"),
      new Error("restart two failed"),
      new Error("restart three failed"),
    );
    clock.advance(2_001);

    expect(engine.readinessAssessment()).toEqual({
      ready: false,
      reason: "capture-buffer-stale",
      secondsSinceLastBuffer: 2.101,
    });
    await engine.waitForRecoveryIdle();

    expect(source.startCallCount).toBe(4);
    expect(restartActions).toEqual(["restartProcess"]);
    expect(engine.readinessAssessment().ready).toBe(false);
  });

  it("uses the Electron relaunch and temporary-failure exit by default", async () => {
    const actions: string[] = [];
    await restartElectronApplication({
      relaunch: () => actions.push("relaunch"),
      exit: (code) => actions.push(`exit:${code}`),
    });
    expect(actions).toEqual(["relaunch", "exit:75"]);
  });

  it("clears prebuffer samples when disposed and restarted", async () => {
    await startEngineAndFeedFrames(engine, source, clock, 5);
    expect(engine.prebufferAvailableMilliseconds()).toBe(500);
    await engine.dispose();
    expect(engine.prebufferAvailableMilliseconds()).toBe(0);

    source.rewind();
    await startEngineAndFeedFrames(engine, source, clock, 1);
    expect(engine.prebufferAvailableMilliseconds()).toBe(100);
  });

  it("waits for delayed recovery and never restarts after disposal", async () => {
    await startEngineAndFeedFrames(engine, source, clock, 1);
    const releaseRecoveryStop = source.blockNextStop();
    clock.advance(2_001);
    expect(engine.readinessAssessment().reason).toBe("capture-buffer-stale");
    expect(source.stopCallCount).toBe(1);

    let disposalFinished = false;
    const disposal = engine.dispose().then(() => {
      disposalFinished = true;
    });
    await Promise.resolve();
    expect(disposalFinished).toBe(false);

    releaseRecoveryStop();
    await disposal;
    await engine.waitForRecoveryIdle();

    expect(source.startCallCount).toBe(1);
    expect(source.stopCallCount).toBe(2);
    expect(engine.readinessAssessment().reason).toBe("capture-engine-stopped");
  });

  it("preserves and reports startup plus cleanup failures", async () => {
    const startFailure = new Error("source start failed");
    const cleanupFailure = new Error("source cleanup failed");
    const reported: Error[] = [];
    source.queueStartFailures(startFailure);
    source.queueStopFailures(cleanupFailure);
    engine = createEngine(source, clock, directory, undefined, {
      onError: (error) => reported.push(error),
    });

    let thrown: unknown;
    try {
      await engine.startAsync();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([
      startFailure,
      cleanupFailure,
    ]);
    expect(reported.at(-1)).toBe(thrown);
    expect(engine.engineHealthMessage).toContain("source start failed");
    expect(engine.engineHealthMessage).toContain("source cleanup failed");
  });

  it("rejects a source error that arrives while awaiting the first frame", async () => {
    const streamFailure = new Error("microphone stream failed before first frame");
    const reported: Error[] = [];
    engine = createEngine(source, clock, directory, undefined, {
      onError: (error) => reported.push(error),
    });

    const startup = engine.startAsync();
    source.failStream(streamFailure.message);

    await expect(startup).rejects.toThrow(streamFailure.message);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.message).toBe(streamFailure.message);
    expect(engine.readinessAssessment().reason).toBe("capture-engine-stopped");
  });

  it("preserves and reports WAV failure plus temp cleanup failure", async () => {
    const renameFailure = new Error("WAV rename failed");
    const cleanupFailure = new Error("temp removal failed");
    const reported: Error[] = [];
    const fileSystem: CaptureFileSystem = {
      makeDirectory: async () => undefined,
      write: async () => undefined,
      rename: async () => {
        throw renameFailure;
      },
      remove: async () => {
        throw cleanupFailure;
      },
    };
    engine = createEngine(source, clock, directory, undefined, {
      fileSystem,
      onError: (error) => reported.push(error),
    });
    await startEngineAndFeedFrames(engine, source, clock, 1);
    engine.startSession("fast");
    feedFrames(source, clock, 1);

    let thrown: unknown;
    try {
      await engine.stopSession(false);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([
      renameFailure,
      cleanupFailure,
    ]);
    expect(reported.at(-1)).toBe(thrown);
  });

  it("clears state and reports a dispose cleanup failure", async () => {
    const cleanupFailure = new Error("capture stop failed");
    const reported: Error[] = [];
    engine = createEngine(source, clock, directory, undefined, {
      onError: (error) => reported.push(error),
    });
    await startEngineAndFeedFrames(engine, source, clock, 2);
    source.queueStopFailures(cleanupFailure);

    await expect(engine.dispose()).rejects.toBe(cleanupFailure);
    expect(engine.prebufferAvailableMilliseconds()).toBe(0);
    expect(engine.readinessAssessment().reason).toBe("capture-engine-stopped");
    expect(reported).toContain(cleanupFailure);
  });

  it("surfaces enforced preferred-device failures as not ready", async () => {
    engine = new CaptureEngine({
      source,
      config: {
        prebufferMilliseconds: 1_000,
        preferredInputDevice: "Missing Microphone",
        enforcePreferredInputDevice: true,
        tempDirectory: directory,
      },
      clock,
      startupTimeoutMilliseconds: 50,
    });

    await expect(engine.startAsync()).rejects.toThrow(
      "Preferred audio input device not found: Missing Microphone",
    );
    expect(engine.readinessAssessment()).toMatchObject({
      ready: false,
      reason: "capture-engine-stopped",
    });
  });

  it("rejects duplicate starts and stop without a session", async () => {
    await startEngineAndFeedFrames(engine, source, clock, 1);
    engine.startSession("fast");
    expect(() => engine.startSession("robust")).toThrowError(
      new CaptureEngineError(
        "already-recording",
        "A recording is already active.",
      ),
    );
    await engine.stopSession(true);
    await expect(engine.stopSession(false)).rejects.toThrow(
      "There is no active recording session.",
    );
  });
});

function createEngine(
  source: FakeCaptureSource,
  clock: FakeCaptureClock,
  directory: string,
  restartProcess: (() => void) | undefined = () => undefined,
  overrides: Partial<CaptureEngineOptions> = {},
): CaptureEngine {
  return new CaptureEngine({
    source,
    config: {
      prebufferMilliseconds: 1_000,
      preferredInputDevice: null,
      enforcePreferredInputDevice: false,
      tempDirectory: directory,
    },
    clock,
    dateClock: clock,
    ...(restartProcess === undefined ? {} : { restartProcess }),
    delay: async () => undefined,
    startupTimeoutMilliseconds: 100,
    restartRetryDelayMilliseconds: 0,
    createSessionId: () => "00000000-0000-0000-0000-000000000001",
    ...overrides,
  });
}

async function startEngineAndFeedFrames(
  engine: CaptureEngine,
  source: FakeCaptureSource,
  clock: FakeCaptureClock,
  frameCount: number,
): Promise<void> {
  const startup = engine.startAsync();
  feedFrames(source, clock, frameCount);
  await startup;
}

function feedFrames(
  source: FakeCaptureSource,
  clock: FakeCaptureClock,
  count: number,
): void {
  for (let index = 0; index < count; index += 1) {
    source.emitNextFrame();
    clock.advance(100);
  }
}
