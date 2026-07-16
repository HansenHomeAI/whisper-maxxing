import { readFile, statfs } from "node:fs/promises";

import {
  JSONSocketServer,
  SessionResultBuffer,
  appPaths,
  type AppConfig,
  type CaptureBackend,
  type ControlRequest,
  type ControlResponse,
  type SessionResultPayload,
  type StatusPayload,
  type TranscriptionProfile,
} from "../core/index.js";
import type {
  CaptureEngine,
  StoppedCapture as CaptureStoppedCapture,
} from "./capture/index.js";
import {
  TranscriptionManager,
  type StoppedCapture as TranscriptionStoppedCapture,
} from "./transcription/index.js";

const LOW_DISK_SPACE_BYTES = 512 * 1024 * 1024;

export interface ElectronDaemonOptions {
  config: AppConfig;
  captureEngine: CaptureEngine;
  captureBackend?: CaptureBackend;
  openSettings(): Promise<ControlResponse>;
  onCompleted?(result: SessionResultPayload): void | Promise<void>;
  requestQuit(): void | Promise<void>;
  reportError?(error: Error): void;
}

export class ElectronDaemon {
  private readonly config: AppConfig;
  private readonly captureEngine: CaptureEngine;
  private readonly captureBackend: CaptureBackend;
  private readonly openSettings: () => Promise<ControlResponse>;
  private readonly onCompleted: (
    result: SessionResultPayload,
  ) => void | Promise<void>;
  private readonly requestQuit: () => void | Promise<void>;
  private readonly reportError: (error: Error) => void;
  private readonly completedResults = new SessionResultBuffer();
  private readonly transcriptionManager: TranscriptionManager;
  private readonly controlServer: JSONSocketServer;
  private disposePromise: Promise<void> | null = null;

  constructor(options: ElectronDaemonOptions) {
    this.config = options.config;
    this.captureEngine = options.captureEngine;
    this.captureBackend = options.captureBackend ?? "electron-renderer";
    this.openSettings = options.openSettings;
    this.onCompleted = options.onCompleted ?? (() => undefined);
    this.requestQuit = options.requestQuit;
    this.reportError = options.reportError ?? ((error) => console.error(error));
    this.transcriptionManager = new TranscriptionManager({
      config: this.config,
      paths: appPaths(this.config),
      onCompleted: (result) => this.storeCompleted(result),
      dependencies: { errorReporter: this.reportError },
    });
    this.controlServer = new JSONSocketServer(
      this.config.controlHost,
      this.config.controlPort,
      (request) => this.handle(request),
      this.reportError,
    );
  }

  async start(): Promise<void> {
    await this.captureEngine.startAsync();
    await this.controlServer.start();
    void Promise.resolve()
      .then(() => this.transcriptionManager.prewarmServerIfNeeded())
      .catch((error: unknown) => this.reportError(asError(error)));
  }

  async handle(request: ControlRequest): Promise<ControlResponse> {
    switch (request.command) {
      case "warmup":
        return { ok: true };
      case "start":
        return this.startCapture("fast");
      case "startRobust":
        return this.startCapture("robust");
      case "stop":
        return this.stopCapture(false);
      case "cancel":
        return this.stopCapture(true);
      case "retryRobust":
        return this.retryRobust();
      case "nextResult":
        return this.nextResult(request.sessionId);
      case "status":
        return this.statusResponse();
      case "openSettings":
        return this.openSettings();
      case "shutdown":
        this.scheduleQuit();
        return { ok: true };
    }
  }

  async dispose(): Promise<void> {
    if (this.disposePromise !== null) {
      await this.disposePromise;
      return;
    }
    const disposePromise = this.disposeResources();
    this.disposePromise = disposePromise;
    await disposePromise;
  }

  private startCapture(profile: TranscriptionProfile): ControlResponse {
    try {
      const started = this.captureEngine.startSession(profile);
      return {
        ok: true,
        recording: true,
        pendingCount: this.outstandingResultCount(),
        sessionId: started.sessionId,
        status: this.makeStatusPayload(true),
      };
    } catch (error) {
      return failure(error);
    }
  }

  private async stopCapture(discard: boolean): Promise<ControlResponse> {
    try {
      const capture = await this.captureEngine.stopSession(discard);
      if (capture !== null) {
        this.transcriptionManager.enqueue(await transcriptionCapture(capture));
      }
      const response: ControlResponse = {
        ok: true,
        recording: false,
        pendingCount: this.outstandingResultCount(),
        status: this.makeStatusPayload(false),
      };
      if (capture !== null) {
        response.sessionId = capture.sessionId;
      }
      return response;
    } catch (error) {
      return failure(error);
    }
  }

  private retryRobust(): ControlResponse {
    if (this.captureEngine.isRecording()) {
      return {
        ok: false,
        error: "Stop the current recording before retranscribing it.",
      };
    }
    try {
      const sessionId = this.transcriptionManager.enqueueRobustRetry();
      return {
        ok: true,
        recording: false,
        pendingCount: this.outstandingResultCount(),
        sessionId,
        status: this.makeStatusPayload(false),
      };
    } catch (error) {
      return failure(error);
    }
  }

  private nextResult(sessionId?: string | null): ControlResponse {
    const result = this.completedResults.popNext(sessionId);
    return {
      ok: true,
      recording: this.captureEngine.isRecording(),
      pendingCount: this.outstandingResultCount(),
      resultAvailable: result !== null,
      result,
    };
  }

  private async statusResponse(): Promise<ControlResponse> {
    const recording = this.captureEngine.isRecording();
    return {
      ok: true,
      recording,
      pendingCount: this.outstandingResultCount(),
      status: await this.makeDetailedStatusPayload(recording),
    };
  }

  private makeStatusPayload(recording: boolean): StatusPayload {
    const readiness = this.captureEngine.readinessAssessment();
    return {
      recording,
      recordingProfile: this.captureEngine.currentRecordingProfile(),
      pendingCount: this.outstandingResultCount(),
      engineReady: readiness.ready,
      engineHealthMessage: captureHealthMessage(readiness.reason),
      engineStartupMilliseconds: this.captureEngine.engineStartupMilliseconds,
      prebufferAvailableMilliseconds:
        this.captureEngine.prebufferAvailableMilliseconds(),
      preferredInputDevice: this.config.preferredInputDevice,
      defaultInputDevice: this.captureEngine.defaultInputDeviceName,
      captureBackend: this.captureBackend,
      serverState: this.transcriptionManager.currentServerState("fast"),
      robustServerState:
        this.transcriptionManager.currentServerState("robust"),
      availableDiskSpaceBytes: null,
      lowDiskSpaceMessage: null,
    };
  }

  private async makeDetailedStatusPayload(
    recording: boolean,
  ): Promise<StatusPayload> {
    const status = this.makeStatusPayload(recording);
    try {
      const disk = await statfs(this.config.tempDirectory);
      const availableBytes = Number(disk.bavail) * Number(disk.bsize);
      status.availableDiskSpaceBytes = availableBytes;
      status.lowDiskSpaceMessage =
        availableBytes <= LOW_DISK_SPACE_BYTES
          ? `Disk Almost Full (${formatBytes(availableBytes)} free)`
          : null;
    } catch {
      // Disk status is advisory; an unavailable filesystem probe remains explicit as null.
    }
    return status;
  }

  private storeCompleted(result: SessionResultPayload): void {
    this.completedResults.append(result);
    void Promise.resolve()
      .then(() => this.onCompleted(result))
      .catch((error: unknown) => this.reportError(asError(error)));
  }

  private outstandingResultCount(): number {
    return (
      this.transcriptionManager.pendingCount() + this.completedResults.count()
    );
  }

  private scheduleQuit(): void {
    const timer = setTimeout(() => {
      void Promise.resolve()
        .then(() => this.requestQuit())
        .catch((error: unknown) => this.reportError(asError(error)));
    }, 200);
    timer.unref();
  }

  private async disposeResources(): Promise<void> {
    const failures: Error[] = [];
    for (const dispose of [
      () => this.controlServer.stop(),
      () => this.transcriptionManager.stop(),
      () => this.captureEngine.dispose(),
    ]) {
      try {
        await dispose();
      } catch (error) {
        failures.push(asError(error));
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Electron daemon shutdown failed");
    }
  }
}

async function transcriptionCapture(
  capture: CaptureStoppedCapture,
): Promise<TranscriptionStoppedCapture> {
  const wav = await readFile(capture.wavPath);
  if (
    wav.length < 44 ||
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.toString("ascii", 8, 12) !== "WAVE" ||
    wav.toString("ascii", 36, 40) !== "data"
  ) {
    throw new Error(`Capture WAV is invalid: ${capture.wavPath}`);
  }
  const dataLength = wav.readUInt32LE(40);
  if (dataLength % 2 !== 0 || 44 + dataLength > wav.length) {
    throw new Error(`Capture WAV data is invalid: ${capture.wavPath}`);
  }
  const samples = new Int16Array(dataLength / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = wav.readInt16LE(44 + index * 2);
  }
  return {
    sessionId: capture.sessionId,
    transcriptionProfile: capture.transcriptionProfile,
    startedAt: capture.startedAt,
    stoppedAt: capture.stoppedAt,
    prebufferMilliseconds: capture.prebufferMilliseconds,
    samples,
    signalMetrics: capture.signalMetrics,
  };
}

function captureHealthMessage(reason: string | null): string | null {
  if (reason === null) {
    return null;
  }
  switch (reason) {
    case "capture-engine-stopped":
      return "Audio Input Recovering";
    case "capture-buffer-missing":
      return "Audio Input Warming Up";
    case "capture-buffer-stale":
      return "Audio Input Stalled";
    default:
      return "Audio Input Not Ready";
  }
}

function formatBytes(bytes: number): string {
  const gibibytes = bytes / (1024 * 1024 * 1024);
  return `${gibibytes.toFixed(1)} GB`;
}

function failure(error: unknown): ControlResponse {
  return { ok: false, error: asError(error).message };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
