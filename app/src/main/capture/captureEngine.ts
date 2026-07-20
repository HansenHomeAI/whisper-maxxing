import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AppConfig } from "../../core/appConfig.js";
import {
  assessCaptureReadiness,
  type CaptureReadinessAssessment,
} from "../../core/captureReadiness.js";
import { assessCaptureRestart } from "../../core/captureRestartPolicy.js";
import { Int16RingBuffer } from "../../core/int16RingBuffer.js";
import { mono16BitPCMData } from "../../core/wavFileWriter.js";
import type {
  CapturedAudioFrame,
  CaptureClock,
  CaptureDateClock,
  CaptureSource,
} from "./captureSource.js";
import {
  systemCaptureClock,
  systemCaptureDateClock,
} from "./captureSource.js";
import { restartElectronApplication } from "./electronRestart.js";
import type {
  RecordingSpool,
  RecoveryStore,
} from "../reliability/recoveryStore.js";

const SAMPLE_RATE = 16_000;
const STARTUP_TIMEOUT_MILLISECONDS = 2_000;
const RESTART_RETRY_DELAY_MILLISECONDS = 1_000;
const SILENT_PEAK_THRESHOLD_DECIBELS = -50;
const SILENT_RMS_THRESHOLD_DECIBELS = -55;

export type TranscriptionProfile = "fast" | "robust";

export interface AudioSignalMetrics {
  peakDecibels: number;
  rmsDecibels: number;
  probablySilent: boolean;
}

export interface StoppedCapture {
  sessionId: string;
  transcriptionProfile: TranscriptionProfile;
  startedAt: Date;
  stoppedAt: Date;
  prebufferMilliseconds: number;
  wavPath: string;
  sampleCount: number;
  audioDurationMilliseconds: number;
  wallClockMilliseconds: number;
  activeAudioMilliseconds: number;
  droppedMilliseconds: number;
  signalMetrics: AudioSignalMetrics;
}

export type CaptureEngineErrorCode =
  | "startup-timed-out"
  | "capture-recovering"
  | "already-recording"
  | "no-active-session"
  | "session-mismatch"
  | "recording-storage-failed";

export class CaptureEngineError extends Error {
  constructor(
    readonly code: CaptureEngineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CaptureEngineError";
  }
}

interface ActiveCaptureSession {
  sessionId: string;
  transcriptionProfile: TranscriptionProfile;
  startedAt: Date;
  prebufferMilliseconds: number;
  samples: number[] | null;
  spool: RecordingSpool | null;
}

export interface CaptureEngineOptions {
  source: CaptureSource;
  config: Pick<
    AppConfig,
    | "prebufferMilliseconds"
    | "preferredInputDevice"
    | "enforcePreferredInputDevice"
    | "tempDirectory"
  >;
  clock?: CaptureClock;
  dateClock?: CaptureDateClock;
  restartProcess?: () => void | Promise<void>;
  onError?: (error: Error) => void;
  fileSystem?: CaptureFileSystem;
  delay?: (milliseconds: number) => Promise<void>;
  startupTimeoutMilliseconds?: number;
  restartRetryDelayMilliseconds?: number;
  createSessionId?: () => string;
  recoveryStore?: RecoveryStore;
  onForcedStop?: (capture: StoppedCapture, reason: string) => void | Promise<void>;
}

export interface CaptureFileSystem {
  makeDirectory(path: string): Promise<void>;
  write(path: string, data: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export class CaptureEngine {
  private readonly source: CaptureSource;
  private readonly config: CaptureEngineOptions["config"];
  private readonly clock: CaptureClock;
  private readonly dateClock: CaptureDateClock;
  private readonly restartProcess: () => void | Promise<void>;
  private readonly onError: (error: Error) => void;
  private readonly fileSystem: CaptureFileSystem;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly startupTimeoutMilliseconds: number;
  private readonly restartRetryDelayMilliseconds: number;
  private readonly createSessionId: () => string;
  private readonly recoveryStore: RecoveryStore | null;
  private forcedStopHandler: (capture: StoppedCapture, reason: string) => void | Promise<void>;
  private forcedStopInFlight = false;
  private readonly ringBuffer: Int16RingBuffer;
  private activeSession: ActiveCaptureSession | null = null;
  private sessionStarting = false;
  private engineRunning = false;
  private startupInProgress = false;
  private startupSignaled = false;
  private lastFrameAtMilliseconds: number | null = null;
  private firstFrameWaiter: (() => void) | null = null;
  private firstFrameRejecter: ((error: Error) => void) | null = null;
  private startupError: Error | null = null;
  private recoveryPromise: Promise<void> | null = null;
  private deferredRestartReason: string | null = null;
  private consecutiveRestartFailures = 0;
  private disposed = false;
  private lifecycleGeneration = 0;

  engineStartupMilliseconds: number | null = null;
  defaultInputDeviceName: string | null = null;
  engineHealthMessage: string | null = null;

  constructor(options: CaptureEngineOptions) {
    this.source = options.source;
    this.config = options.config;
    this.clock = options.clock ?? systemCaptureClock;
    this.dateClock = options.dateClock ?? systemCaptureDateClock;
    this.restartProcess =
      options.restartProcess ?? restartElectronApplication;
    this.onError = options.onError ?? (() => undefined);
    this.fileSystem = options.fileSystem ?? nodeCaptureFileSystem;
    this.delay = options.delay ?? defaultDelay;
    this.startupTimeoutMilliseconds =
      options.startupTimeoutMilliseconds ?? STARTUP_TIMEOUT_MILLISECONDS;
    this.restartRetryDelayMilliseconds =
      options.restartRetryDelayMilliseconds ?? RESTART_RETRY_DELAY_MILLISECONDS;
    this.createSessionId = options.createSessionId ?? randomUUID;
    this.recoveryStore = options.recoveryStore ?? null;
    this.forcedStopHandler = options.onForcedStop ?? (() => undefined);
    this.ringBuffer = new Int16RingBuffer(
      Math.trunc(options.config.prebufferMilliseconds * 16),
    );
  }

  async startAsync(): Promise<void> {
    this.disposed = false;
    const generation = ++this.lifecycleGeneration;
    await this.startSource(generation);
  }

  async startSession(profile: TranscriptionProfile): Promise<{
    sessionId: string;
    prebufferMilliseconds: number;
  }> {
    const readiness = this.readinessAssessment();
    if (!readiness.ready) {
      this.scheduleRestart("session-start-not-ready");
      throw new CaptureEngineError(
        "capture-recovering",
        "Audio input is recovering. Try dictation again in a moment.",
      );
    }
    if (this.activeSession !== null || this.sessionStarting) {
      throw new CaptureEngineError(
        "already-recording",
        "A recording is already active.",
      );
    }

    let prebuffer = this.ringBuffer.snapshot();
    const sessionId = this.createSessionId().toLowerCase();
    const startedAt = this.dateClock.nowDate();
    let spool: RecordingSpool | null = null;
    this.sessionStarting = true;
    try {
      spool =
        (await this.recoveryStore?.createSpool(
          sessionId,
          profile,
          startedAt,
          new Int16Array(),
        )) ?? null;
      if (spool !== null) {
        prebuffer = this.ringBuffer.snapshot();
        spool.metadata.prebufferMilliseconds = prebuffer.length / 16;
        spool.append(prebuffer);
        await spool.checkpoint();
        spool.markStarted();
      }
    } catch (error) {
      const surfaced = new CaptureEngineError(
        "recording-storage-failed",
        `Recording storage failed; recording stopped. ${errorMessage(error)}`,
      );
      this.surfaceError(surfaced);
      throw surfaced;
    } finally {
      this.sessionStarting = false;
    }
    this.activeSession = {
      sessionId,
      transcriptionProfile: profile,
      startedAt,
      prebufferMilliseconds: prebuffer.length / 16,
      samples: spool === null ? Array.from(prebuffer) : null,
      spool,
    };
    return { sessionId, prebufferMilliseconds: prebuffer.length / 16 };
  }

  async stopSession(
    discard: boolean,
    expectedSessionId?: string | null,
  ): Promise<StoppedCapture | null> {
    const session = this.activeSession;
    if (session === null) {
      throw new CaptureEngineError(
        "no-active-session",
        "There is no active recording session.",
      );
    }
    if (
      expectedSessionId !== undefined &&
      expectedSessionId !== null &&
      expectedSessionId !== session.sessionId
    ) {
      throw new CaptureEngineError(
        "session-mismatch",
        "The recording session does not match the active session.",
      );
    }
    this.activeSession = null;

    if (discard) {
      await session.spool?.cancel();
      this.restartAfterSessionIfNeeded();
      return null;
    }

    const stoppedAt = this.dateClock.nowDate();
    const samples = session.samples === null ? null : Int16Array.from(session.samples);
    let wavPath: string;
    let sampleCount: number;
    let signalMetrics: AudioSignalMetrics;
    try {
      if (session.spool !== null) {
        const finalized = await session.spool.finalize(stoppedAt);
        wavPath = finalized.wavPath;
        sampleCount = finalized.metadata.sampleCount;
        signalMetrics = session.spool.signalMetrics();
      } else {
        const fallbackSamples = samples ?? new Int16Array();
        wavPath = join(this.config.tempDirectory, `${session.sessionId}.wav`);
        await writeWavAtomically(wavPath, fallbackSamples, this.fileSystem);
        sampleCount = fallbackSamples.length;
        signalMetrics = analyzeSignal(fallbackSamples);
      }
    } catch (error) {
      if (session.spool === null) {
        this.surfaceError(toError(error));
        throw error;
      }
      const surfaced = new CaptureEngineError(
        "recording-storage-failed",
        `Recording storage failed; recording stopped. ${errorMessage(error)}`,
      );
      this.surfaceError(surfaced);
      throw surfaced;
    }
    const audioDurationMilliseconds = sampleCount / 16;
    const wallClockMilliseconds = Math.max(
      stoppedAt.getTime() - session.startedAt.getTime(),
      0,
    );
    const activeAudioMilliseconds = Math.max(
      audioDurationMilliseconds - session.prebufferMilliseconds,
      0,
    );
    const droppedMilliseconds = Math.max(
      wallClockMilliseconds - activeAudioMilliseconds,
      0,
    );
    if (signalMetrics.probablySilent) {
      this.scheduleRestart(
        `silent capture detected (peak ${formatDecibels(signalMetrics.peakDecibels)} dBFS, rms ${formatDecibels(signalMetrics.rmsDecibels)} dBFS)`,
      );
    } else {
      this.restartAfterSessionIfNeeded();
    }

    return {
      sessionId: session.sessionId,
      transcriptionProfile: session.transcriptionProfile,
      startedAt: session.startedAt,
      stoppedAt,
      prebufferMilliseconds: session.prebufferMilliseconds,
      wavPath,
      sampleCount,
      audioDurationMilliseconds,
      wallClockMilliseconds,
      activeAudioMilliseconds,
      droppedMilliseconds,
      signalMetrics,
    };
  }

  isRecording(): boolean {
    return this.activeSession !== null;
  }

  currentSessionId(): string | null {
    return this.activeSession?.sessionId ?? null;
  }

  setForcedStopHandler(
    handler: (capture: StoppedCapture, reason: string) => void | Promise<void>,
  ): void {
    this.forcedStopHandler = handler;
  }

  lastFrameAgeMilliseconds(): number | null {
    return this.lastFrameAtMilliseconds === null
      ? null
      : Math.max(this.clock.now() - this.lastFrameAtMilliseconds, 0);
  }

  async preserveActive(reason: string): Promise<StoppedCapture | null> {
    if (this.activeSession === null) {
      return null;
    }
    const sessionId = this.activeSession.sessionId;
    const capture = await this.stopSession(false, sessionId);
    await this.recoveryStore?.retain(sessionId, reason);
    return capture;
  }

  currentRecordingProfile(): TranscriptionProfile | null {
    return this.activeSession?.transcriptionProfile ?? null;
  }

  prebufferAvailableMilliseconds(): number {
    return this.ringBuffer.availableMilliseconds;
  }

  readinessAssessment(): CaptureReadinessAssessment {
    const secondsSinceLastBuffer =
      this.lastFrameAtMilliseconds === null
        ? null
        : Math.max(this.clock.now() - this.lastFrameAtMilliseconds, 0) / 1_000;
    const assessment = assessCaptureReadiness(
      this.engineRunning || this.startupInProgress,
      this.startupSignaled && !this.startupInProgress,
      secondsSinceLastBuffer,
    );
    if (assessment.reason === "capture-buffer-stale") {
      if (this.activeSession !== null) {
        this.forceStopActive("capture_stalled");
      }
      this.scheduleRestart("capture-buffer-stale");
    }
    return assessment;
  }

  async waitForRecoveryIdle(): Promise<void> {
    await this.recoveryPromise;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.lifecycleGeneration += 1;
    if (this.activeSession !== null) {
      await this.preserveActive("shutdown");
    }
    this.deferredRestartReason = null;
    this.firstFrameRejecter?.(new CaptureLifecycleCancelledError());
    const recovery = this.recoveryPromise;
    if (recovery !== null) {
      await recovery;
    }
    try {
      await this.source.stop();
    } catch (error) {
      const surfacedError = toError(error);
      this.surfaceError(surfacedError);
      throw surfacedError;
    } finally {
      this.markStopped();
    }
  }

  private async startSource(generation: number): Promise<boolean> {
    this.startupInProgress = true;
    this.startupSignaled = false;
    this.startupError = null;
    this.lastFrameAtMilliseconds = null;
    const startedAt = this.clock.now();

    try {
      const info = await withTimeout(
        this.source.start({
          preferredInputDevice: this.config.preferredInputDevice,
          enforcePreferredInputDevice: this.config.enforcePreferredInputDevice,
          onFrame: (frame) => {
            if (this.isCurrentGeneration(generation)) {
              this.handleFrame(frame);
            }
          },
          onError: (error) => {
            if (!this.isCurrentGeneration(generation)) {
              return;
            }
            if (this.startupInProgress) {
              this.startupError = error;
              this.firstFrameRejecter?.(error);
              return;
            }
            this.surfaceError(error);
            this.scheduleRestart(error.message);
          },
        }),
        this.startupTimeoutMilliseconds,
      );
      if (!this.isCurrentGeneration(generation)) {
        return false;
      }
      this.defaultInputDeviceName = info.defaultInputDeviceName;
      this.engineRunning = true;
      const elapsedMilliseconds = Math.max(this.clock.now() - startedAt, 0);
      await this.waitForFirstFrame(
        Math.max(this.startupTimeoutMilliseconds - elapsedMilliseconds, 1),
      );
      if (!this.isCurrentGeneration(generation)) {
        return false;
      }
      this.engineStartupMilliseconds = Math.max(this.clock.now() - startedAt, 0);
      this.startupInProgress = false;
      this.consecutiveRestartFailures = 0;
      this.engineHealthMessage = null;
      return true;
    } catch (error) {
      if (!this.isCurrentGeneration(generation)) {
        return false;
      }
      let surfacedError = toError(error);
      this.markStopped();
      try {
        await this.source.stop();
      } catch (cleanupError) {
        if (!this.isCurrentGeneration(generation)) {
          return false;
        }
        surfacedError = combineErrors(
          surfacedError,
          toError(cleanupError),
          "Audio capture startup and source cleanup both failed.",
        );
      }
      if (!this.isCurrentGeneration(generation)) {
        return false;
      }
      this.surfaceError(surfacedError);
      throw surfacedError;
    }
  }

  private handleFrame(frame: CapturedAudioFrame): void {
    if (!this.engineRunning && !this.startupInProgress) {
      return;
    }
    this.ringBuffer.append(frame.samples);
    if (this.activeSession !== null) {
      try {
        if (this.activeSession.spool !== null) {
          this.activeSession.spool.append(frame.samples);
        } else {
          this.activeSession.samples?.push(...frame.samples);
        }
      } catch (error) {
        const failure = new CaptureEngineError(
          "recording-storage-failed",
          `Recording storage failed; recording stopped. ${errorMessage(error)}`,
        );
        this.surfaceError(failure);
        this.forceStopActive("recording_storage_failed");
      }
    }
    this.lastFrameAtMilliseconds = this.clock.now();
    if (!this.startupSignaled) {
      this.startupSignaled = true;
      this.firstFrameWaiter?.();
      this.firstFrameWaiter = null;
    }
  }

  private async waitForFirstFrame(timeoutMilliseconds: number): Promise<void> {
    if (this.startupError !== null) {
      throw this.startupError;
    }
    if (this.startupSignaled) {
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          this.firstFrameWaiter = resolve;
          this.firstFrameRejecter = reject;
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(
              new CaptureEngineError(
                "startup-timed-out",
                "Audio capture did not become ready in time.",
              ),
            );
          }, timeoutMilliseconds);
        }),
      ]);
    } finally {
      if (timeout !== null) {
        clearTimeout(timeout);
      }
      this.firstFrameWaiter = null;
      this.firstFrameRejecter = null;
    }
  }

  private forceStopActive(reason: string): void {
    if (this.activeSession === null || this.forcedStopInFlight) {
      return;
    }
    const sessionId = this.activeSession.sessionId;
    this.forcedStopInFlight = true;
    void Promise.resolve()
      .then(async () => {
        const capture = await this.stopSession(false, sessionId);
        if (capture !== null) {
          await this.recoveryStore?.retain(sessionId, reason);
          await this.forcedStopHandler(capture, reason);
        }
      })
      .catch((error: unknown) => this.surfaceError(toError(error)))
      .finally(() => {
        this.forcedStopInFlight = false;
      });
  }

  private scheduleRestart(reason: string): void {
    if (this.disposed) {
      return;
    }
    if (this.activeSession !== null) {
      this.deferredRestartReason = reason;
      return;
    }
    if (this.recoveryPromise !== null) {
      return;
    }
    const generation = this.lifecycleGeneration;
    const recovery = this.recover(reason, generation)
      .catch((error: unknown) => {
        if (this.isCurrentGeneration(generation)) {
          this.surfaceError(toError(error));
        }
      })
      .finally(() => {
        if (this.recoveryPromise === recovery) {
          this.recoveryPromise = null;
        }
      });
    this.recoveryPromise = recovery;
  }

  private async recover(_reason: string, generation: number): Promise<void> {
    while (this.isCurrentGeneration(generation)) {
      try {
        await this.source.stop();
        if (!this.isCurrentGeneration(generation)) {
          return;
        }
        this.markStopped();
        const started = await this.startSource(generation);
        if (!this.isCurrentGeneration(generation) || !started) {
          return;
        }
        return;
      } catch (error) {
        if (!this.isCurrentGeneration(generation)) {
          return;
        }
        this.consecutiveRestartFailures += 1;
        this.surfaceError(
          new Error(`Audio capture restart failed: ${errorMessage(error)}`),
        );
        const decision = assessCaptureRestart(
          this.consecutiveRestartFailures,
        );
        if (decision.action === "restartProcess") {
          await this.restartProcess();
          if (!this.isCurrentGeneration(generation)) {
            return;
          }
          return;
        }
        await this.delay(this.restartRetryDelayMilliseconds);
        if (!this.isCurrentGeneration(generation)) {
          return;
        }
      }
    }
  }

  private restartAfterSessionIfNeeded(): void {
    if (this.deferredRestartReason === null) {
      return;
    }
    const reason = this.deferredRestartReason;
    this.deferredRestartReason = null;
    this.scheduleRestart(`deferred: ${reason}`);
  }

  private markStopped(): void {
    this.engineRunning = false;
    this.startupInProgress = false;
    this.startupSignaled = false;
    this.lastFrameAtMilliseconds = null;
    this.firstFrameWaiter = null;
    this.firstFrameRejecter = null;
    this.startupError = null;
    this.ringBuffer.clear();
  }

  private surfaceError(error: Error): void {
    this.engineHealthMessage = errorMessage(error);
    this.onError(error);
  }

  private isCurrentGeneration(generation: number): boolean {
    return !this.disposed && generation === this.lifecycleGeneration;
  }
}

class CaptureLifecycleCancelledError extends Error {
  constructor() {
    super("Audio capture lifecycle was cancelled.");
    this.name = "CaptureLifecycleCancelledError";
  }
}

function analyzeSignal(samples: Int16Array): AudioSignalMetrics {
  if (samples.length === 0) {
    return {
      peakDecibels: Number.NEGATIVE_INFINITY,
      rmsDecibels: Number.NEGATIVE_INFINITY,
      probablySilent: true,
    };
  }

  let peakMagnitude = 0;
  let meanSquare = 0;
  for (const sample of samples) {
    const normalized = Math.abs(sample) / 32_767;
    peakMagnitude = Math.max(peakMagnitude, normalized);
    meanSquare += normalized * normalized;
  }
  const rmsMagnitude = Math.sqrt(meanSquare / samples.length);
  const peakDecibels = decibels(peakMagnitude);
  const rmsDecibels = decibels(rmsMagnitude);
  return {
    peakDecibels,
    rmsDecibels,
    probablySilent:
      peakDecibels <= SILENT_PEAK_THRESHOLD_DECIBELS &&
      rmsDecibels <= SILENT_RMS_THRESHOLD_DECIBELS,
  };
}

function decibels(magnitude: number): number {
  return magnitude > 0 ? 20 * Math.log10(magnitude) : Number.NEGATIVE_INFINITY;
}

function formatDecibels(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : "-inf";
}

async function writeWavAtomically(
  path: string,
  samples: Int16Array,
  fileSystem: CaptureFileSystem,
): Promise<void> {
  await fileSystem.makeDirectory(dirname(path));
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await fileSystem.write(
      temporaryPath,
      mono16BitPCMData(samples, SAMPLE_RATE),
    );
    await fileSystem.rename(temporaryPath, path);
  } catch (error) {
    try {
      await fileSystem.remove(temporaryPath);
    } catch (cleanupError) {
      throw combineErrors(
        toError(error),
        toError(cleanupError),
        "Writing the capture WAV and cleaning its temporary file both failed.",
      );
    }
    throw toError(error);
  }
}

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    const details = error.errors.map(errorMessage).join("; ");
    return details.length > 0 ? `${error.message} ${details}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function combineErrors(
  primary: Error,
  cleanup: Error,
  message: string,
): AggregateError {
  return new AggregateError([primary, cleanup], message);
}

const nodeCaptureFileSystem: CaptureFileSystem = {
  makeDirectory: async (path) => {
    await mkdir(path, { recursive: true });
  },
  write: async (path, data) => {
    await writeFile(path, data);
  },
  rename,
  remove: async (path) => {
    await rm(path, { force: true });
  },
};

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMilliseconds: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(
            new CaptureEngineError(
              "startup-timed-out",
              "Audio capture did not become ready in time.",
            ),
          );
        }, timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}
