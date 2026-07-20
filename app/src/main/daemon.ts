import { open, statfs } from "node:fs/promises";

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
import type { LocalDiagnostics, RecoveryStore } from "./reliability/index.js";

const LOW_DISK_SPACE_BYTES = 512 * 1024 * 1024;

export interface ElectronDaemonOptions {
  config: AppConfig;
  captureEngine: CaptureEngine;
  captureBackend?: CaptureBackend;
  openSettings(): Promise<ControlResponse>;
  onCompleted?(result: SessionResultPayload): void | Promise<void>;
  requestQuit(): void | Promise<void>;
  reportError?(error: Error): void;
  recoveryStore?: RecoveryStore;
  diagnostics?: LocalDiagnostics;
  processInstanceId?: string;
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
  private readonly recoveryStore: RecoveryStore | null;
  private readonly diagnostics: LocalDiagnostics | null;
  private readonly processInstanceId: string;
  private readonly recoveryOwners = new Map<string, string>();

  constructor(options: ElectronDaemonOptions) {
    this.config = options.config;
    this.captureEngine = options.captureEngine;
    this.captureBackend = options.captureBackend ?? "electron-renderer";
    this.openSettings = options.openSettings;
    this.onCompleted = options.onCompleted ?? (() => undefined);
    this.requestQuit = options.requestQuit;
    this.reportError = options.reportError ?? ((error) => console.error(error));
    this.recoveryStore = options.recoveryStore ?? null;
    this.diagnostics = options.diagnostics ?? null;
    this.processInstanceId = options.processInstanceId ?? "unknown";
    this.transcriptionManager = new TranscriptionManager({
      config: this.config,
      paths: appPaths(this.config),
      onCompleted: (result) => this.storeCompleted(result),
      dependencies: {
        errorReporter: this.reportError,
        diagnosticReporter: (event) =>
          this.diagnostics?.record({
            component: "transcription",
            event: event.event,
            sessionId: event.sessionId,
            ...(event.fields === undefined ? {} : { fields: event.fields }),
          }),
      },
    });
    this.captureEngine.setForcedStopHandler(async (capture, reason) => {
      await this.recoveryStore?.retain(capture.sessionId, reason);
      this.transcriptionManager.enqueue(await transcriptionCapture(capture));
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
        return this.stopCapture(false, request.sessionId);
      case "cancel":
        return this.stopCapture(true, request.sessionId);
      case "retryRobust":
        return this.retryRobust();
      case "nextResult":
        return this.nextResult(request.sessionId);
      case "ackResult":
        return this.ackResult(request.sessionId, request.deliveryOutcome);
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

  private async startCapture(profile: TranscriptionProfile): Promise<ControlResponse> {
    try {
      const started = await this.captureEngine.startSession(profile);
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

  private async stopCapture(
    discard: boolean,
    expectedSessionId?: string | null,
  ): Promise<ControlResponse> {
    try {
      const capture = await this.captureEngine.stopSession(discard, expectedSessionId);
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
      const sourceSessionId = this.transcriptionManager.lastRetryableSessionId();
      if (sourceSessionId !== null) {
        this.recoveryStore?.hold(sourceSessionId);
      }
      const sessionId = this.transcriptionManager.enqueueRobustRetry();
      if (sourceSessionId !== null) {
        this.recoveryOwners.set(sessionId, sourceSessionId);
      }
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

  private async ackResult(
    sessionId?: string | null,
    outcome?: "delivered" | "pasteFailed" | "noOutput" | null,
  ): Promise<ControlResponse> {
    if (!sessionId || !outcome) {
      return { ok: false, error: "ackResult requires sessionId and deliveryOutcome." };
    }
    try {
      const recoverySessionId = this.recoveryOwners.get(sessionId) ?? sessionId;
      await this.recoveryStore?.acknowledge(recoverySessionId, outcome);
      this.recoveryOwners.delete(sessionId);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
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
      activeSessionId: this.captureEngine.currentSessionId(),
      processInstanceId: this.processInstanceId,
      lastFrameAgeMilliseconds: this.captureEngine.lastFrameAgeMilliseconds(),
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
      .then(async () => {
        const recoverySessionId = this.recoveryOwners.get(result.sessionId) ?? result.sessionId;
        if (result.text.length > 0 && !result.errorMessage) {
          await this.recoveryStore?.awaitingDelivery(recoverySessionId);
        } else {
          await this.recoveryStore?.retain(
            recoverySessionId,
            result.errorMessage ? "transcription_failed" : "no_output",
          );
        }
        this.diagnostics?.record({
          component: "transcription",
          event: "transcription_completed",
          sessionId: result.sessionId,
          fields: {
            hasText: result.text.length > 0,
            hasError: Boolean(result.errorMessage),
          },
        });
        await this.onCompleted(result);
      })
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
    if (this.captureEngine.isRecording()) {
      try {
        await this.captureEngine.preserveActive("shutdown");
      } catch (error) {
        failures.push(asError(error));
      }
    }
    for (const dispose of [
      () => this.controlServer.stop(),
      () => this.captureEngine.dispose(),
      () => this.transcriptionManager.stop(),
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
  const handle = await open(capture.wavPath, "r");
  const header = Buffer.alloc(44);
  try {
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (
      bytesRead < 44 ||
      header.toString("ascii", 0, 4) !== "RIFF" ||
      header.toString("ascii", 8, 12) !== "WAVE" ||
      header.toString("ascii", 36, 40) !== "data"
    ) {
      throw new Error(`Capture WAV is invalid: ${capture.wavPath}`);
    }
    const dataLength = header.readUInt32LE(40);
    const details = await handle.stat();
    if (dataLength % 2 !== 0 || 44 + dataLength > details.size) {
      throw new Error(`Capture WAV data is invalid: ${capture.wavPath}`);
    }
  } finally {
    await handle.close();
  }
  return {
    sessionId: capture.sessionId,
    transcriptionProfile: capture.transcriptionProfile,
    startedAt: capture.startedAt,
    stoppedAt: capture.stoppedAt,
    prebufferMilliseconds: capture.prebufferMilliseconds,
    wavPath: capture.wavPath,
    sampleCount: capture.sampleCount,
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
