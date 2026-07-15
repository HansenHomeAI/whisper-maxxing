import type { ControlResponse } from "../../core/controlProtocol.js";
import { normalizeTranscript } from "./normalizeTranscript.js";
import {
  consoleLogger,
  systemScheduler,
  type AlertSink,
  type ControlClient,
  type Logger,
  type OverlaySink,
  type PasteEnginePort,
  type ReplacementTarget,
  type Scheduler,
  type SessionResultPayload,
  type StatusPayload,
  type TranscriptionProfile,
} from "./types.js";
import { UX_CONTRACT, UX_MILLISECONDS, withPendingCount } from "./uxContract.js";

export type DictationState = "idle" | "starting" | "recording" | "stopping";

interface PendingSession {
  sessionId: string;
  profile: TranscriptionProfile;
}

interface LastDictationPaste {
  sessionId: string;
  profile: TranscriptionProfile;
  pastedAtSeconds: number;
  appIdentity: string | null;
}

export interface DictationSnapshot {
  state: DictationState;
  profile: TranscriptionProfile;
  pendingCount: number;
  pendingSessionIds: readonly string[];
  polling: boolean;
}

export interface DictationControllerOptions {
  controlClient: ControlClient;
  alerts: AlertSink;
  overlay: OverlaySink;
  pasteEngine: PasteEnginePort;
  scheduler?: Scheduler;
  logger?: Logger;
}

export class DictationController {
  private readonly controlClient: ControlClient;
  private readonly alerts: AlertSink;
  private readonly overlay: OverlaySink;
  private readonly pasteEngine: PasteEnginePort;
  private readonly scheduler: Scheduler;
  private readonly logger: Logger;
  private state: DictationState = "idle";
  private profile: TranscriptionProfile = "fast";
  private pendingCount = 0;
  private pendingSessions: PendingSession[] = [];
  private replacementTargets = new Map<string, ReplacementTarget>();
  private lastDictationPaste: LastDictationPaste | null = null;
  private pollTimer: unknown | null = null;
  private pollInFlight = false;
  private lastHealthWarningAt = Number.NEGATIVE_INFINITY;

  constructor(options: DictationControllerOptions) {
    this.controlClient = options.controlClient;
    this.alerts = options.alerts;
    this.overlay = options.overlay;
    this.pasteEngine = options.pasteEngine;
    this.scheduler = options.scheduler ?? systemScheduler;
    this.logger = options.logger ?? consoleLogger;
  }

  snapshot(): DictationSnapshot {
    return {
      state: this.state,
      profile: this.profile,
      pendingCount: this.pendingCount,
      pendingSessionIds: this.pendingSessions.map(({ sessionId }) => sessionId),
      polling: this.pollTimer !== null,
    };
  }

  async toggleDictation(): Promise<void> {
    if (this.state === "recording") {
      await this.stopRecording(false);
      return;
    }
    await this.startRecording("fast");
  }

  async warmup(): Promise<void> {
    try {
      const response = await this.controlClient.send({ command: "warmup" });
      if (!response.ok) {
        throw new Error(response.error ?? "Dictation warmup failed");
      }
    } catch (error) {
      await this.surfaceOperationalError("dictation warmup error", error);
    }
  }

  async startRecording(profile: TranscriptionProfile = "fast"): Promise<void> {
    if (this.state === "recording") {
      await this.showAlert(this.recordingLabel(this.profile));
      return;
    }
    if (this.state === "starting" || this.state === "stopping") {
      return;
    }

    this.state = "starting";
    this.profile = profile;
    await this.showAlert(
      profile === "robust" ? UX_CONTRACT.alerts.startingRobust : UX_CONTRACT.alerts.starting,
    );

    try {
      const response = await this.controlClient.send({
        command: profile === "robust" ? "startRobust" : "start",
      });
      if (!response.ok) {
        throw new Error(response.error ?? UX_CONTRACT.alerts.startFailed);
      }
      this.state = "recording";
      this.profile = profile;
      await this.overlay.showRecording(profile);
      await this.maybeWarnAboutStatus(response.status);
      await this.showAlert(this.recordingLabel(profile));
    } catch (error) {
      this.state = "idle";
      this.profile = "fast";
      await this.overlay.hideRecording();
      await this.showAlert(errorMessage(error, UX_CONTRACT.alerts.startFailed));
    }
  }

  async stopRecording(discard: boolean): Promise<void> {
    if (this.state !== "recording") {
      await this.showAlert(UX_CONTRACT.alerts.noSession);
      return;
    }

    this.state = "stopping";
    const stoppedProfile = this.profile;
    await this.overlay.hideRecording();

    try {
      const response = await this.controlClient.send({ command: discard ? "cancel" : "stop" });
      this.state = "idle";
      this.profile = "fast";
      if (!response.ok) {
        throw new Error(response.error ?? UX_CONTRACT.alerts.stopFailed);
      }

      this.pendingCount = response.pendingCount ?? this.pendingCount;
      if (discard) {
        await this.showAlert(
          stoppedProfile === "robust"
            ? UX_CONTRACT.alerts.recordingCanceledRobust
            : UX_CONTRACT.alerts.recordingCanceled,
        );
        return;
      }

      this.enqueuePendingSession(response.sessionId, stoppedProfile);
      await this.maybeWarnAboutStatus(response.status);
      this.ensureResultPolling();
      await this.showAlert(
        withPendingCount(this.processingLabel(stoppedProfile), this.pendingCount),
      );
    } catch (error) {
      this.state = "idle";
      this.profile = "fast";
      await this.showAlert(errorMessage(error, UX_CONTRACT.alerts.stopFailed));
    }
  }

  async cancelRecording(): Promise<void> {
    await this.stopRecording(true);
  }

  async retryRobustTranscription(): Promise<void> {
    if (this.state === "recording") {
      await this.showAlert(UX_CONTRACT.alerts.stopRecordingFirst);
      return;
    }
    if (this.state === "starting" || this.state === "stopping") {
      return;
    }

    const replacementTarget = await this.replacementTargetForLastPaste();
    await this.showAlert(
      replacementTarget
        ? UX_CONTRACT.alerts.retryingWillReplace
        : UX_CONTRACT.alerts.retryingLastAudio,
    );

    try {
      const response = await this.controlClient.send({ command: "retryRobust" });
      if (!response.ok) {
        throw new Error(response.error ?? UX_CONTRACT.alerts.retryFailed);
      }
      this.pendingCount = response.pendingCount ?? this.pendingCount;
      this.enqueuePendingSession(response.sessionId, "robust");
      if (response.sessionId && replacementTarget) {
        this.replacementTargets.set(response.sessionId, replacementTarget);
      }
      await this.maybeWarnAboutStatus(response.status);
      this.ensureResultPolling();
      await this.showAlert(
        withPendingCount(UX_CONTRACT.alerts.processingRobust, this.pendingCount),
      );
    } catch (error) {
      await this.showAlert(errorMessage(error, UX_CONTRACT.alerts.retryFailed));
    }
  }

  async restoreState(): Promise<void> {
    try {
      const response = await this.controlClient.send({ command: "status" });
      if (!response.ok || !response.status) {
        throw new Error(response.error ?? "Unable to restore dictation state");
      }
      this.pendingCount = response.pendingCount ?? response.status.pendingCount;
      await this.reconcileRecordingState(response.status, true);
      await this.maybeWarnAboutStatus(response.status);
      if (this.pendingCount > 0) {
        this.ensureResultPolling();
      }
    } catch (error) {
      await this.surfaceOperationalError("dictation restore error", error);
    }
  }

  async watchDaemonStatus(): Promise<void> {
    if (this.state === "starting" || this.state === "stopping") {
      return;
    }
    try {
      const response = await this.controlClient.send({ command: "status" });
      if (!response.ok || !response.status) {
        throw new Error(response.error ?? "Unable to watch dictation status");
      }
      this.pendingCount = response.pendingCount ?? response.status.pendingCount;
      await this.reconcileRecordingState(response.status, false);
      await this.maybeWarnAboutStatus(response.status);
      if (this.pendingCount > 0) {
        this.ensureResultPolling();
      } else {
        this.stopResultPolling();
      }
    } catch (error) {
      await this.surfaceOperationalError("dictation watchdog error", error);
    }
  }

  async pollForResults(): Promise<void> {
    if (this.pollInFlight) {
      return;
    }
    this.pollInFlight = true;
    try {
      const response = await this.controlClient.send({ command: "nextResult" });
      if (!response.ok) {
        throw new Error(response.error ?? "Result polling failed");
      }
      this.pendingCount = response.pendingCount ?? this.pendingCount;
      if (response.resultAvailable && response.result) {
        await this.handleResult(response.result);
      }
      if (this.pendingCount <= 0) {
        this.stopResultPolling();
      }
    } catch (error) {
      await this.surfaceOperationalError("dictation poll error", error);
    } finally {
      this.pollInFlight = false;
    }
  }

  stop(): void {
    this.stopResultPolling();
  }

  private async reconcileRecordingState(status: StatusPayload, force: boolean): Promise<void> {
    if (status.recording) {
      const observedProfile = asProfile(status.recordingProfile) ?? this.profile;
      if (force || this.state !== "recording" || this.profile !== observedProfile) {
        await this.overlay.showRecording(observedProfile);
      }
      this.state = "recording";
      this.profile = observedProfile;
      return;
    }
    if (force || this.state === "recording") {
      this.state = "idle";
      this.profile = "fast";
      await this.overlay.hideRecording();
    }
  }

  private ensureResultPolling(): void {
    if (this.pollTimer !== null) {
      return;
    }
    this.pollTimer = this.scheduler.setInterval(() => {
      void this.pollForResults();
    }, UX_MILLISECONDS.resultPollInterval);
  }

  private stopResultPolling(): void {
    if (this.pollTimer === null) {
      return;
    }
    this.scheduler.clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private enqueuePendingSession(
    sessionId: string | null | undefined,
    profile: TranscriptionProfile,
  ): void {
    if (sessionId) {
      this.pendingSessions.push({ sessionId, profile });
    }
  }

  private removePendingSession(sessionId: string): TranscriptionProfile | null {
    const index = this.pendingSessions.findIndex((pending) => pending.sessionId === sessionId);
    if (index < 0) {
      return null;
    }
    const [pending] = this.pendingSessions.splice(index, 1);
    return pending?.profile ?? null;
  }

  private async handleResult(result: SessionResultPayload): Promise<void> {
    const queuedProfile = this.removePendingSession(result.sessionId);
    const resultProfile = asProfile(result.metrics.transcriptionProfile) ?? queuedProfile ?? "fast";
    const replacementTarget = this.replacementTargets.get(result.sessionId);
    this.replacementTargets.delete(result.sessionId);

    if (result.text) {
      this.logSalvage(result.salvagePath);
      const text = normalizeTranscript(result.text);
      if (!text) {
        await this.showAlert(UX_CONTRACT.alerts.noOutput);
        return;
      }
      try {
        await this.pasteEngine.paste(text, replacementTarget);
        this.lastDictationPaste = {
          sessionId: result.sessionId,
          profile: resultProfile,
          pastedAtSeconds: this.scheduler.nowSeconds(),
          appIdentity: await this.pasteEngine.frontmostAppIdentity(),
        };
      } catch (error) {
        await this.surfaceOperationalError("dictation paste error", error);
        return;
      }
      await this.showAlert(
        withPendingCount(this.transcriptReadyLabel(resultProfile), this.pendingCount),
      );
      return;
    }
    if (result.errorMessage) {
      await this.showAlert(result.errorMessage);
      this.logger.error(`dictation error: ${result.errorMessage}`);
      this.logSalvage(result.salvagePath);
      return;
    }
    if (result.salvagePath) {
      await this.showAlert(UX_CONTRACT.alerts.transcriptionFailed);
      this.logSalvage(result.salvagePath);
      return;
    }
    await this.showAlert(UX_CONTRACT.alerts.noOutput);
  }

  private async replacementTargetForLastPaste(): Promise<ReplacementTarget | undefined> {
    const paste = this.lastDictationPaste;
    if (!paste) {
      return undefined;
    }
    const now = this.scheduler.nowSeconds();
    if (now - paste.pastedAtSeconds > UX_CONTRACT.timings.replacementWindowSeconds) {
      return undefined;
    }
    const currentIdentity = await this.pasteEngine.frontmostAppIdentity();
    if (paste.appIdentity && currentIdentity && paste.appIdentity !== currentIdentity) {
      return undefined;
    }
    return {
      originalSessionId: paste.sessionId,
      originalProfile: paste.profile,
      pastedAtSeconds: paste.pastedAtSeconds,
      appIdentity: paste.appIdentity,
      requestedAtSeconds: now,
    };
  }

  private async maybeWarnAboutStatus(status: StatusPayload | null | undefined): Promise<void> {
    if (!status) {
      return;
    }
    const message = healthWarning(status);
    if (!message) {
      return;
    }
    const now = this.scheduler.nowSeconds();
    if (now - this.lastHealthWarningAt < UX_CONTRACT.timings.healthWarningThrottleSeconds) {
      return;
    }
    this.lastHealthWarningAt = now;
    await this.showAlert(message);
  }

  private async showAlert(message: string): Promise<void> {
    await this.alerts.showAlert(message);
  }

  private async surfaceOperationalError(prefix: string, error: unknown): Promise<void> {
    const message = errorMessage(error, prefix);
    this.logger.error(`${prefix}: ${message}`);
    await this.showAlert(message);
  }

  private logSalvage(path: string | null | undefined): void {
    if (path) {
      this.logger.info(`dictation salvage: ${path}`);
    }
  }

  private recordingLabel(profile: TranscriptionProfile): string {
    return profile === "robust"
      ? UX_CONTRACT.alerts.recordingRobust
      : UX_CONTRACT.alerts.recording;
  }

  private processingLabel(profile: TranscriptionProfile): string {
    return profile === "robust"
      ? UX_CONTRACT.alerts.processingRobust
      : UX_CONTRACT.alerts.processing;
  }

  private transcriptReadyLabel(profile: TranscriptionProfile): string {
    return profile === "robust"
      ? UX_CONTRACT.alerts.transcriptReadyRobust
      : UX_CONTRACT.alerts.transcriptReady;
  }
}

function asProfile(profile: string | null | undefined): TranscriptionProfile | null {
  return profile === "fast" || profile === "robust" ? profile : null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function healthWarning(status: StatusPayload): string | null {
  if (status.lowDiskSpaceMessage) {
    return status.lowDiskSpaceMessage;
  }
  if (status.engineReady) {
    return null;
  }
  const health = status.engineHealthMessage;
  if (health && Object.hasOwn(UX_CONTRACT.healthMessages, health)) {
    return UX_CONTRACT.healthMessages[
      health as keyof Omit<typeof UX_CONTRACT.healthMessages, "default" | "lowDiskFormat">
    ];
  }
  return health || UX_CONTRACT.healthMessages.default;
}

export function controlResponse(overrides: Partial<ControlResponse> = {}): ControlResponse {
  return { ok: true, ...overrides };
}
