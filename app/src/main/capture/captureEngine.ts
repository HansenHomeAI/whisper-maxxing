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
  | "no-active-session";

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
  startedAtMilliseconds: number;
  prebufferMilliseconds: number;
  samples: number[];
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
  private readonly ringBuffer: Int16RingBuffer;
  private activeSession: ActiveCaptureSession | null = null;
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
    this.ringBuffer = new Int16RingBuffer(
      Math.trunc(options.config.prebufferMilliseconds * 16),
    );
  }

  async startAsync(): Promise<void> {
    this.disposed = false;
    await this.startSource();
  }

  startSession(profile: TranscriptionProfile): {
    sessionId: string;
    prebufferMilliseconds: number;
  } {
    const readiness = this.readinessAssessment();
    if (!readiness.ready) {
      this.scheduleRestart("session-start-not-ready");
      throw new CaptureEngineError(
        "capture-recovering",
        "Audio input is recovering. Try dictation again in a moment.",
      );
    }
    if (this.activeSession !== null) {
      throw new CaptureEngineError(
        "already-recording",
        "A recording is already active.",
      );
    }

    const prebuffer = this.ringBuffer.snapshot();
    const prebufferMilliseconds = prebuffer.length / 16;
    const sessionId = this.createSessionId().toLowerCase();
    const startedAtMilliseconds = this.clock.now();
    this.activeSession = {
      sessionId,
      transcriptionProfile: profile,
      startedAt: this.dateClock.nowDate(),
      startedAtMilliseconds,
      prebufferMilliseconds,
      samples: Array.from(prebuffer),
    };
    return { sessionId, prebufferMilliseconds };
  }

  async stopSession(discard: boolean): Promise<StoppedCapture | null> {
    const session = this.activeSession;
    if (session === null) {
      throw new CaptureEngineError(
        "no-active-session",
        "There is no active recording session.",
      );
    }
    this.activeSession = null;

    if (discard) {
      this.restartAfterSessionIfNeeded();
      return null;
    }

    const stoppedAtMilliseconds = this.clock.now();
    const stoppedAt = this.dateClock.nowDate();
    const samples = Int16Array.from(session.samples);
    const signalMetrics = analyzeSignal(samples);
    const audioDurationMilliseconds = samples.length / 16;
    const wallClockMilliseconds = Math.max(
      stoppedAtMilliseconds - session.startedAtMilliseconds,
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
    const wavPath = join(this.config.tempDirectory, `${session.sessionId}.wav`);
    try {
      await writeWavAtomically(wavPath, samples, this.fileSystem);
    } catch (error) {
      this.surfaceError(toError(error));
      throw error;
    }

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
      sampleCount: samples.length,
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
      this.scheduleRestart("capture-buffer-stale");
    }
    return assessment;
  }

  async waitForRecoveryIdle(): Promise<void> {
    await this.recoveryPromise;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.activeSession = null;
    this.deferredRestartReason = null;
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

  private async startSource(): Promise<void> {
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
          onFrame: (frame) => this.handleFrame(frame),
          onError: (error) => {
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
      this.defaultInputDeviceName = info.defaultInputDeviceName;
      this.engineRunning = true;
      const elapsedMilliseconds = Math.max(this.clock.now() - startedAt, 0);
      await this.waitForFirstFrame(
        Math.max(this.startupTimeoutMilliseconds - elapsedMilliseconds, 1),
      );
      this.engineStartupMilliseconds = Math.max(this.clock.now() - startedAt, 0);
      this.startupInProgress = false;
      this.consecutiveRestartFailures = 0;
      this.engineHealthMessage = null;
    } catch (error) {
      let surfacedError = toError(error);
      this.markStopped();
      try {
        await this.source.stop();
      } catch (cleanupError) {
        surfacedError = combineErrors(
          surfacedError,
          toError(cleanupError),
          "Audio capture startup and source cleanup both failed.",
        );
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
      this.activeSession.samples.push(...frame.samples);
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
    this.recoveryPromise = this.recover(reason)
      .catch((error: unknown) => {
        this.surfaceError(toError(error));
      })
      .finally(() => {
        this.recoveryPromise = null;
      });
  }

  private async recover(_reason: string): Promise<void> {
    while (!this.disposed) {
      try {
        await this.source.stop();
        this.markStopped();
        this.ringBuffer.clear();
        await this.startSource();
        return;
      } catch (error) {
        this.consecutiveRestartFailures += 1;
        this.surfaceError(
          new Error(`Audio capture restart failed: ${errorMessage(error)}`),
        );
        const decision = assessCaptureRestart(
          this.consecutiveRestartFailures,
        );
        if (decision.action === "restartProcess") {
          await this.restartProcess();
          return;
        }
        await this.delay(this.restartRetryDelayMilliseconds);
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
