import { randomUUID } from "node:crypto";
import { constants as fileConstants, openAsBlob } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readdir,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import {
  assessCaptureIntegrity,
  assessTranscriptQuality,
  isLoopbackControlHost,
  mono16BitPCMData,
  type AppConfig,
  type AppPaths,
  type CaptureIntegrityAssessment,
  type SessionMetrics,
  type SessionResultPayload,
  type TranscriptQualityAssessment,
  type TranscriptionProfile,
} from "../../core/index.js";
import { errorMessage, TranscriptionError } from "./errors.js";
import { NodeProcessSpawner } from "./nodeProcessSpawner.js";
import type {
  Clock,
  DiskSpaceStatus,
  DiskStatusProvider,
  FetchResponse,
  HttpFetcher,
  ManagedProcess,
  ProcessSpawner,
  ServerState,
  StoppedCapture,
  TranscriptionManagerDependencies,
  TranscriptionManagerOptions,
} from "./types.js";

const RECENT_CAPTURE_LIMIT = 12;
const VAD_ACTIVATION_MILLISECONDS = 15_000;
const VAD_MIN_SILENCE_MILLISECONDS = 350;
const VAD_SPEECH_PAD_MILLISECONDS = 80;
const MAX_ERROR_MESSAGE_LENGTH = 1_000;
const LOW_DISK_SPACE_BYTES = 512 * 1024 * 1024;
const CRITICAL_DISK_SPACE_BYTES = 192 * 1024 * 1024;

interface PendingTranscription {
  capture: StoppedCapture;
  wavPath: string;
  wavData?: Uint8Array;
  enqueuedAt: Date;
}

interface ServerConfig {
  profile: TranscriptionProfile;
  modelPath: string;
  port: number;
  requestTimeoutSeconds: number;
  warmOnLaunch: boolean;
  logPath: string;
}

interface TranscriptDiagnostic {
  reason: string;
  rawTranscript: string;
  cleanedTranscript: string;
}

type TranscriptOutcome =
  | { kind: "text"; text: string; diagnostic: TranscriptDiagnostic | null }
  | { kind: "no-speech" };

const defaultClock: Clock = {
  now: () => new Date(),
  sleep: async (milliseconds) => {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  },
  uuid: () => randomUUID().toLowerCase(),
};

const defaultFetcher: HttpFetcher = async (input, init) =>
  fetch(input, init) as Promise<FetchResponse>;

const defaultDiskStatusProvider: DiskStatusProvider = async (path) => {
  let details;
  try {
    details = await statfs(path);
  } catch {
    try {
      details = await statfs(dirname(path));
    } catch {
      return null;
    }
  }
  const availableBytes = Number(details.bavail) * Number(details.bsize);
  return {
    availableBytes,
    lowSpace: availableBytes <= LOW_DISK_SPACE_BYTES,
    criticalSpace: availableBytes <= CRITICAL_DISK_SPACE_BYTES,
    summary: formatBytes(availableBytes),
  };
};

export class TranscriptionManager {
  private readonly config: AppConfig;
  private readonly paths: AppPaths;
  private readonly onCompleted: (result: SessionResultPayload) => void;
  private readonly fetcher: HttpFetcher;
  private readonly processSpawner: ProcessSpawner;
  private readonly clock: Clock;
  private readonly cliEnvironment: NodeJS.ProcessEnv;
  private readonly diskStatusProvider: DiskStatusProvider;
  private readonly errorReporter: (error: Error) => void;
  private readonly diagnosticReporter: NonNullable<TranscriptionManagerDependencies["diagnosticReporter"]>;
  private readonly lifecycle = new AsyncMutex();
  private readonly pending: PendingTranscription[] = [];
  private processing = false;
  private stopped = false;
  private lastRetryableCapture: PendingTranscription | null = null;
  private readonly serverProcesses = new Map<TranscriptionProfile, ManagedProcess>();
  private readonly serverStates = new Map<TranscriptionProfile, ServerState>([
    ["fast", "stopped"],
    ["robust", "stopped"],
  ]);

  constructor(options: TranscriptionManagerOptions) {
    this.config = options.config;
    this.paths = options.paths;
    this.onCompleted = options.onCompleted;
    const dependencies: TranscriptionManagerDependencies =
      options.dependencies ?? {};
    this.fetcher = dependencies.fetcher ?? defaultFetcher;
    this.processSpawner = dependencies.processSpawner ?? new NodeProcessSpawner();
    this.clock = dependencies.clock ?? defaultClock;
    this.cliEnvironment = dependencies.cliEnvironment ?? process.env;
    this.diskStatusProvider =
      dependencies.diskStatusProvider ?? defaultDiskStatusProvider;
    this.errorReporter =
      dependencies.errorReporter ?? ((error) => console.error(error.message));
    this.diagnosticReporter = dependencies.diagnosticReporter ?? (() => undefined);

    if (!isLoopbackControlHost(this.config.whisperServerHost)) {
      throw new Error("whisperServerHost must be loopback-only");
    }
  }

  enqueue(capture: StoppedCapture): void {
    if (this.stopped) {
      throw new Error("The transcription manager is stopped.");
    }
    const pending = this.makePending(capture);
    this.lastRetryableCapture = pending;
    this.pending.push(pending);
    this.processNextIfNeeded();
  }

  enqueueRobustRetry(): string {
    this.assertRunning();
    this.serverConfig("robust");
    if (this.lastRetryableCapture === null) {
      throw TranscriptionError.noRetryableCapture();
    }
    const sessionId = this.clock.uuid();
    const capture: StoppedCapture = {
      ...this.lastRetryableCapture.capture,
      sessionId,
      transcriptionProfile: "robust",
    };
    const pending: PendingTranscription = {
      capture,
      wavPath: this.lastRetryableCapture.wavPath,
      ...(this.lastRetryableCapture.wavData === undefined
        ? {}
        : { wavData: this.lastRetryableCapture.wavData }),
      enqueuedAt: this.clock.now(),
    };
    this.lastRetryableCapture = pending;
    this.pending.push(pending);
    this.processNextIfNeeded();
    return sessionId;
  }

  pendingCount(): number {
    return this.pending.length + (this.processing ? 1 : 0);
  }

  lastRetryableSessionId(): string | null {
    return this.lastRetryableCapture?.capture.sessionId ?? null;
  }

  currentServerState(profile: TranscriptionProfile): ServerState {
    return this.serverStates.get(profile) ?? "stopped";
  }

  async prewarmServerIfNeeded(): Promise<void> {
    for (const profile of ["fast", "robust"] as const) {
      let server: ServerConfig;
      try {
        server = this.serverConfig(profile);
      } catch (error) {
        if (profile === "robust") {
          continue;
        }
        this.report(error);
        continue;
      }
      if (!server.warmOnLaunch) {
        continue;
      }
      try {
        await this.ensureServerReady(server, this.startupTimeoutSeconds(server));
      } catch (error) {
        this.report(error);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.lifecycle.runExclusive(async () => {
      for (const profile of ["fast", "robust"] as const) {
        await this.terminateServerProcess(profile);
        this.serverProcesses.delete(profile);
        this.serverStates.set(profile, "stopped");
      }
    });
  }

  private makePending(capture: StoppedCapture): PendingTranscription {
    const wavPath = capture.wavPath ?? join(this.paths.tempDirectory, `${capture.sessionId}.wav`);
    return {
      capture,
      wavPath,
      ...(capture.wavPath === undefined && capture.samples !== undefined
        ? { wavData: mono16BitPCMData(capture.samples, 16_000) }
        : {}),
      enqueuedAt: this.clock.now(),
    };
  }

  private processNextIfNeeded(): void {
    if (this.processing || this.pending.length === 0) {
      return;
    }
    const next = this.pending.shift();
    if (next === undefined) {
      return;
    }
    this.processing = true;
    void this.transcribe(next)
      .catch(async (error: unknown) => {
        const diskStatus = await this.currentDiskStatus();
        return this.failedResult(next, error, diskStatus, null);
      })
      .then((result) => {
        try {
          this.onCompleted(result);
        } catch (error) {
          this.report(error);
        }
      })
      .finally(() => {
        this.processing = false;
        this.processNextIfNeeded();
      });
  }

  private async transcribe(
    pending: PendingTranscription,
  ): Promise<SessionResultPayload> {
    this.diagnosticReporter({
      event: "transcription_started",
      sessionId: pending.capture.sessionId,
      fields: { profile: pending.capture.transcriptionProfile },
    });
    const queueWaitMilliseconds =
      pending.enqueuedAt.getTime() - pending.capture.stoppedAt.getTime();
    const startedAt = this.clock.now();
    const integrity = this.captureIntegrity(pending.capture);
    const diskStatus = await this.currentDiskStatus();

    if (integrity.requiresFailure) {
      return this.captureIncompleteResult(pending, integrity, diskStatus);
    }
    if (pending.capture.signalMetrics.probablySilent) {
      return this.noSpeechResult(
        pending.capture,
        this.transcriptionMode("silent-capture", pending.capture.transcriptionProfile),
        startedAt,
        queueWaitMilliseconds,
      );
    }

    try {
      const serverOutcome = await this.transcribeViaServerWithRecovery(pending);
      if (serverOutcome.kind === "text") {
        const assessment = this.qualityAssessment(
          pending.capture,
          serverOutcome.text,
        );
        if (assessment.requiresSecondPass) {
          return this.secondPassResult(
            pending,
            serverOutcome.text,
            serverOutcome.diagnostic,
            assessment,
            startedAt,
            queueWaitMilliseconds,
            diskStatus,
          );
        }
        return this.acceptedTextResult(
          pending,
          serverOutcome.text,
          serverOutcome.diagnostic,
          assessment,
          this.transcriptionMode("server", pending.capture.transcriptionProfile),
          startedAt,
          queueWaitMilliseconds,
        );
      }

      if (!this.shouldAttemptCliFallback(pending.capture, diskStatus)) {
        return this.noSpeechResult(
          pending.capture,
          this.transcriptionMode("no-speech", pending.capture.transcriptionProfile),
          startedAt,
          queueWaitMilliseconds,
        );
      }
      try {
        const cliOutcome = await this.transcribeViaCLI(pending);
        return this.resultFromCliOutcome(
          pending,
          cliOutcome,
          startedAt,
          queueWaitMilliseconds,
          diskStatus,
        );
      } catch (error) {
        return this.failedResult(
          pending,
          new TranscriptionError(
            `CLI fallback after no-speech result failed: ${errorMessage(error)}`,
          ),
          diskStatus,
          null,
        );
      }
    } catch (serverError) {
      try {
        const cliOutcome = await this.transcribeViaCLI(pending);
        return this.resultFromCliOutcome(
          pending,
          cliOutcome,
          startedAt,
          queueWaitMilliseconds,
          diskStatus,
        );
      } catch (cliError) {
        return this.failedResult(
          pending,
          TranscriptionError.combined(serverError, cliError),
          diskStatus,
          null,
        );
      }
    }
  }

  private async resultFromCliOutcome(
    pending: PendingTranscription,
    outcome: TranscriptOutcome,
    startedAt: Date,
    queueWaitMilliseconds: number,
    diskStatus: DiskSpaceStatus | null,
  ): Promise<SessionResultPayload> {
    if (outcome.kind === "no-speech") {
      return this.noSpeechResult(
        pending.capture,
        this.transcriptionMode("no-speech", pending.capture.transcriptionProfile),
        startedAt,
        queueWaitMilliseconds,
      );
    }
    const assessment = this.qualityAssessment(pending.capture, outcome.text);
    if (assessment.requiresSecondPass) {
      return this.lowConfidenceResult(
        pending,
        assessment.reason ?? "low-confidence-transcript",
        null,
        outcome.text,
        assessment,
        diskStatus,
      );
    }
    return this.acceptedTextResult(
      pending,
      outcome.text,
      outcome.diagnostic,
      assessment,
      this.transcriptionMode("cli", pending.capture.transcriptionProfile),
      startedAt,
      queueWaitMilliseconds,
    );
  }

  private async acceptedTextResult(
    pending: PendingTranscription,
    text: string,
    diagnostic: TranscriptDiagnostic | null,
    assessment: TranscriptQualityAssessment,
    mode: string,
    startedAt: Date,
    queueWaitMilliseconds: number,
  ): Promise<SessionResultPayload> {
    const salvagePath =
      diagnostic === null
        ? null
        : await this.persistSalvage(pending, diagnostic);
    if (this.config.persistRecentCaptures) {
      await this.persistRecentCapture(pending, text, mode, assessment);
    }
    return this.completedResult(
      pending.capture,
      text,
      salvagePath,
      mode,
      startedAt,
      queueWaitMilliseconds,
    );
  }

  private async secondPassResult(
    pending: PendingTranscription,
    serverText: string,
    serverDiagnostic: TranscriptDiagnostic | null,
    serverAssessment: TranscriptQualityAssessment,
    startedAt: Date,
    queueWaitMilliseconds: number,
    diskStatus: DiskSpaceStatus | null,
  ): Promise<SessionResultPayload> {
    try {
      const outcome = await this.transcribeViaCLI(pending);
      if (outcome.kind === "no-speech") {
        return this.lowConfidenceResult(
          pending,
          serverAssessment.reason ?? "low-confidence-transcript",
          serverText,
          null,
          serverAssessment,
          diskStatus,
        );
      }
      const cliAssessment = this.qualityAssessment(pending.capture, outcome.text);
      if (cliAssessment.requiresSecondPass) {
        return this.lowConfidenceResult(
          pending,
          cliAssessment.reason ??
            serverAssessment.reason ??
            "low-confidence-transcript",
          serverText,
          outcome.text,
          cliAssessment,
          diskStatus,
        );
      }
      return this.acceptedTextResult(
        pending,
        outcome.text,
        outcome.diagnostic ?? serverDiagnostic,
        cliAssessment,
        this.transcriptionMode(
          "cli-second-pass",
          pending.capture.transcriptionProfile,
        ),
        startedAt,
        queueWaitMilliseconds,
      );
    } catch (error) {
      return this.lowConfidenceResult(
        pending,
        serverAssessment.reason ?? "low-confidence-transcript",
        serverText,
        `CLI second pass failed: ${errorMessage(error)}`,
        serverAssessment,
        diskStatus,
      );
    }
  }

  private async lowConfidenceResult(
    pending: PendingTranscription,
    reason: string,
    serverText: string | null,
    fallbackText: string | null,
    assessment: TranscriptQualityAssessment,
    diskStatus: DiskSpaceStatus | null,
  ): Promise<SessionResultPayload> {
    const diagnostic: TranscriptDiagnostic = {
      reason,
      rawTranscript: [
        `audio_duration_ms: ${Math.trunc(assessment.audioDurationMilliseconds)}`,
        `words_per_second: ${assessment.wordsPerSecond.toFixed(2)}`,
        `characters_per_second: ${assessment.charactersPerSecond.toFixed(2)}`,
        "",
        "server transcript:",
        serverText ?? "(none)",
        "",
        "fallback transcript:",
        fallbackText ?? "(none)",
      ].join("\n"),
      cleanedTranscript: fallbackText ?? serverText ?? "",
    };
    return this.failedResult(
      pending,
      new TranscriptionError(
        "Low-confidence dictation. Audio saved for review.",
      ),
      diskStatus,
      diagnostic,
    );
  }

  private async captureIncompleteResult(
    pending: PendingTranscription,
    assessment: CaptureIntegrityAssessment,
    diskStatus: DiskSpaceStatus | null,
  ): Promise<SessionResultPayload> {
    const reason = assessment.reason ?? "capture-duration-gap";
    const diagnostic: TranscriptDiagnostic = {
      reason,
      rawTranscript: [
        `capture_wall_clock_ms: ${Math.trunc(assessment.captureWallClockMilliseconds)}`,
        `captured_audio_ms: ${Math.trunc(assessment.capturedAudioMilliseconds)}`,
        `prebuffer_ms: ${Math.trunc(assessment.prebufferMilliseconds)}`,
        `active_audio_ms: ${Math.trunc(assessment.activeAudioMilliseconds)}`,
        `dropped_ms: ${Math.trunc(assessment.droppedMilliseconds)}`,
        `coverage_ratio: ${assessment.coverageRatio.toFixed(2)}`,
      ].join("\n"),
      cleanedTranscript: "",
    };
    return this.failedResult(
      pending,
      new TranscriptionError(
        `Audio capture dropped part of this dictation (${reason}). Audio saved for review.`,
      ),
      diskStatus,
      diagnostic,
    );
  }

  private completedResult(
    capture: StoppedCapture,
    text: string,
    salvagePath: string | null,
    mode: string,
    startedAt: Date,
    queueWaitMilliseconds: number,
  ): SessionResultPayload {
    return {
      sessionId: capture.sessionId,
      text,
      metrics: this.metrics(
        capture,
        mode,
        this.clock.now().getTime() - startedAt.getTime(),
        Math.max(queueWaitMilliseconds, 0),
      ),
      salvagePath,
      errorMessage: null,
    };
  }

  private noSpeechResult(
    capture: StoppedCapture,
    mode: string,
    startedAt: Date,
    queueWaitMilliseconds: number,
  ): SessionResultPayload {
    return {
      sessionId: capture.sessionId,
      text: "",
      metrics: this.metrics(
        capture,
        mode,
        this.clock.now().getTime() - startedAt.getTime(),
        Math.max(queueWaitMilliseconds, 0),
      ),
      salvagePath: null,
      errorMessage: null,
    };
  }

  private async failedResult(
    pending: PendingTranscription,
    error: unknown,
    diskStatus: DiskSpaceStatus | null,
    diagnostic: TranscriptDiagnostic | null,
  ): Promise<SessionResultPayload> {
    const message = boundedErrorMessage(
      this.userFacingErrorMessage(error, diskStatus),
    );
    const salvagePath = await this.persistSalvage(pending, diagnostic);
    return {
      sessionId: pending.capture.sessionId,
      text: "",
      metrics: this.metrics(
        pending.capture,
        this.transcriptionMode(
          "failed",
          pending.capture.transcriptionProfile,
        ),
        null,
        null,
      ),
      salvagePath,
      errorMessage: message,
    };
  }

  private metrics(
    capture: StoppedCapture,
    mode: string,
    transcriptionMilliseconds: number | null,
    queueWaitMilliseconds: number | null,
  ): SessionMetrics {
    const integrity = this.captureIntegrity(capture);
    return {
      sessionId: capture.sessionId,
      transcriptionProfile: capture.transcriptionProfile,
      prebufferMilliseconds: capture.prebufferMilliseconds,
      audioDurationMilliseconds: integrity.capturedAudioMilliseconds,
      captureStartedAtISO8601: capture.startedAt.toISOString(),
      captureStoppedAtISO8601: capture.stoppedAt.toISOString(),
      captureWallClockMilliseconds: integrity.captureWallClockMilliseconds,
      activeAudioMilliseconds: integrity.activeAudioMilliseconds,
      captureDroppedMilliseconds: integrity.droppedMilliseconds,
      captureCoverageRatio: integrity.coverageRatio,
      transcriptionMode: mode,
      transcriptionMilliseconds,
      queueWaitMilliseconds,
      completedAtISO8601: this.clock.now().toISOString(),
    };
  }

  private qualityAssessment(
    capture: StoppedCapture,
    text: string,
  ): TranscriptQualityAssessment {
    return assessTranscriptQuality(text, this.audioDurationMilliseconds(capture));
  }

  private captureIntegrity(
    capture: StoppedCapture,
  ): CaptureIntegrityAssessment {
    return assessCaptureIntegrity(
      this.audioDurationMilliseconds(capture),
      capture.prebufferMilliseconds,
      capture.stoppedAt.getTime() - capture.startedAt.getTime(),
    );
  }

  private audioDurationMilliseconds(capture: StoppedCapture): number {
    return (capture.sampleCount ?? capture.samples?.length ?? 0) / 16;
  }

  private transcriptionMode(mode: string, profile: TranscriptionProfile): string {
    return profile === "fast" ? mode : `${profile}-${mode}`;
  }

  private serverConfig(profile: TranscriptionProfile): ServerConfig {
    if (profile === "fast") {
      return {
        profile,
        modelPath: this.config.whisperModelPath,
        port: this.config.whisperServerPort,
        requestTimeoutSeconds: this.config.serverRequestTimeoutSeconds,
        warmOnLaunch: this.config.warmServerOnLaunch,
        logPath: this.paths.whisperServerLogPath,
      };
    }
    const modelPath = this.config.whisperRobustModelPath?.trim() ?? "";
    if (modelPath.length === 0) {
      throw TranscriptionError.robustModelNotConfigured();
    }
    return {
      profile,
      modelPath,
      port: this.config.robustWhisperServerPort,
      requestTimeoutSeconds: this.config.robustServerRequestTimeoutSeconds,
      warmOnLaunch: this.config.warmRobustServerOnLaunch,
      logPath: this.paths.robustWhisperServerLogPath,
    };
  }

  private async ensureServerReady(
    server: ServerConfig,
    timeoutSeconds: number,
  ): Promise<void> {
    await this.lifecycle.runExclusive(() =>
      this.ensureServerReadyLocked(server, timeoutSeconds),
    );
  }

  private async ensureServerReadyLocked(
    server: ServerConfig,
    timeoutSeconds: number,
  ): Promise<void> {
    this.assertRunning();
    const managed = this.serverProcesses.get(server.profile);
    if (managed?.isRunning() === true && (await this.isServerHealthy(server))) {
      this.serverStates.set(server.profile, "ready");
      return;
    }
    this.assertRunning();
    await this.cleanupConflictingServerProcesses(server);
    this.assertRunning();
    if (managed === undefined || !managed.isRunning()) {
      await this.launchServer(server);
    }
    const deadline = this.clock.now().getTime() + timeoutSeconds * 1_000;
    while (this.clock.now().getTime() < deadline) {
      this.assertRunning();
      if (await this.isServerHealthy(server)) {
        this.serverStates.set(server.profile, "ready");
        return;
      }
      await this.clock.sleep(100);
    }
    throw new TranscriptionError(
      `${server.profile} whisper-server did not become ready`,
    );
  }

  private async launchServer(server: ServerConfig): Promise<void> {
    this.serverStates.set(server.profile, "starting");
    const args = [
      "-m",
      server.modelPath,
      "--host",
      this.config.whisperServerHost,
      "--port",
      String(server.port),
      "-t",
      String(this.config.whisperThreads),
    ];
    const vadModel = await this.resolvedVadModelPath();
    if (vadModel !== null) {
      args.push("-vm", vadModel);
    }
    try {
      const process = await this.processSpawner.spawnServer(
        this.config.whisperServerBinary,
        args,
        server.logPath,
      );
      this.serverProcesses.set(server.profile, process);
      if (this.stopped) {
        await this.terminateServerProcess(server.profile);
        this.serverProcesses.delete(server.profile);
        this.serverStates.set(server.profile, "stopped");
        throw new TranscriptionError("The transcription manager is stopped.");
      }
    } catch (error) {
      throw error;
    }
  }

  private async restartServer(profile: TranscriptionProfile): Promise<void> {
    await this.lifecycle.runExclusive(() => this.restartServerLocked(profile));
  }

  private async restartServerLocked(
    profile: TranscriptionProfile,
  ): Promise<void> {
    this.assertRunning();
    await this.terminateServerProcess(profile);
    this.serverProcesses.delete(profile);
    this.serverStates.set(profile, "stopped");
    this.assertRunning();
    const server = this.serverConfig(profile);
    await this.ensureServerReadyLocked(
      server,
      this.startupTimeoutSeconds(server),
    );
  }

  private async terminateServerProcess(
    profile: TranscriptionProfile,
  ): Promise<void> {
    const process = this.serverProcesses.get(profile);
    if (process === undefined || !process.isRunning()) {
      return;
    }
    process.terminate();
    const deadline = this.clock.now().getTime() + 2_000;
    while (process.isRunning() && this.clock.now().getTime() < deadline) {
      await this.clock.sleep(50);
    }
    if (process.isRunning()) {
      process.kill();
      const killDeadline = this.clock.now().getTime() + 500;
      while (
        process.isRunning() &&
        this.clock.now().getTime() < killDeadline
      ) {
        await this.clock.sleep(25);
      }
    }
    if (!process.isRunning()) {
      await process.waitForExit();
    } else {
      this.report(
        new Error(`Unable to terminate whisper-server pid=${process.pid}`),
      );
    }
  }

  private async cleanupConflictingServerProcesses(
    server: ServerConfig,
  ): Promise<void> {
    const processes = await this.processSpawner.listeningProcesses(server.port);
    const managed = this.serverProcesses.get(server.profile);
    for (const process of processes) {
      if (managed?.isRunning() === true && managed.pid === process.pid) {
        continue;
      }
      if (!this.isExpectedServerCommand(process.command, server)) {
        throw new TranscriptionError(
          `Port ${server.port} is already used by another process: ${process.command}`,
        );
      }
      await this.processSpawner.terminatePid(process.pid, false);
      const deadline = this.clock.now().getTime() + 1_000;
      while (
        this.processSpawner.processIsRunning(process.pid) &&
        this.clock.now().getTime() < deadline
      ) {
        await this.clock.sleep(50);
      }
      if (this.processSpawner.processIsRunning(process.pid)) {
        await this.processSpawner.terminatePid(process.pid, true);
        const forceDeadline = this.clock.now().getTime() + 500;
        while (
          this.processSpawner.processIsRunning(process.pid) &&
          this.clock.now().getTime() < forceDeadline
        ) {
          await this.clock.sleep(25);
        }
        if (this.processSpawner.processIsRunning(process.pid)) {
          throw new TranscriptionError(
            `Unable to terminate stale whisper-server pid=${process.pid}`,
          );
        }
      }
    }
  }

  private isExpectedServerCommand(command: string, server: ServerConfig): boolean {
    const tokens = commandLineTokens(command);
    const modelIndex = tokens.indexOf("-m");
    const portIndex = tokens.indexOf("--port");
    const executable = tokens[0];
    const model = modelIndex >= 0 ? tokens[modelIndex + 1] : undefined;
    const port = portIndex >= 0 ? tokens[portIndex + 1] : undefined;
    return (
      (executable !== undefined &&
        matchesPathComponent(executable, this.config.whisperServerBinary) ||
        matchesRawCommandExecutable(command, this.config.whisperServerBinary)) &&
      (model !== undefined && matchesPathComponent(model, server.modelPath) ||
        matchesRawCommandArgument(command, "-m", server.modelPath)) &&
      (port === String(server.port) ||
        matchesRawCommandArgument(command, "--port", String(server.port)))
    );
  }

  private async transcribeViaServerWithRecovery(
    pending: PendingTranscription,
  ): Promise<TranscriptOutcome> {
    this.diagnosticReporter({
      event: "server_attempt_started",
      sessionId: pending.capture.sessionId,
    });
    const server = this.serverConfig(pending.capture.transcriptionProfile);
    try {
      await this.ensureServerReady(server, this.startupTimeoutSeconds(server));
      return await this.transcribeViaServer(server, pending);
    } catch (firstError) {
      this.report(
        new Error(
          `Server transcription failed; restarting once: ${errorMessage(firstError)}`,
        ),
      );
      this.diagnosticReporter({
        event: "server_attempt_retrying",
        sessionId: pending.capture.sessionId,
      });
      await this.restartServer(server.profile);
      const retryServer = this.serverConfig(server.profile);
      try {
        return await this.transcribeViaServer(retryServer, pending);
      } catch (error) {
        throw error;
      }
    }
  }

  private async transcribeViaServer(
    server: ServerConfig,
    pending: PendingTranscription,
  ): Promise<TranscriptOutcome> {
    const form = new FormData();
    form.append("response_format", "json");
    form.append("no_timestamps", "true");
    form.append("temperature", "0.0");
    if (await this.shouldUseVad(pending.capture)) {
      form.append("vad", "true");
      form.append(
        "vad_min_silence_duration_ms",
        String(VAD_MIN_SILENCE_MILLISECONDS),
      );
      form.append("vad_speech_pad_ms", String(VAD_SPEECH_PAD_MILLISECONDS));
    }
    const audio = pending.wavData === undefined
      ? await openAsBlob(pending.wavPath, { type: "audio/wav" })
      : new Blob([Uint8Array.from(pending.wavData).buffer], { type: "audio/wav" });
    form.append("file", audio, basename(pending.wavPath));
    const payload = await this.fetchJSONWithTimeout(
      `http://${this.config.whisperServerHost}:${server.port}/inference`,
      { method: "POST", body: form },
      server.requestTimeoutSeconds,
    );
    const text =
      typeof payload === "object" &&
      payload !== null &&
      "text" in payload &&
      typeof payload.text === "string"
        ? payload.text
        : "";
    return normalizeTranscript(text);
  }

  private async transcribeViaCLI(
    pending: PendingTranscription,
  ): Promise<TranscriptOutcome> {
    this.diagnosticReporter({
      event: "cli_attempt_started",
      sessionId: pending.capture.sessionId,
    });
    const server = this.serverConfig(pending.capture.transcriptionProfile);
    const timeoutSeconds =
      server.profile === "robust"
        ? Math.max(
            this.config.cliTimeoutSeconds,
            server.requestTimeoutSeconds,
          )
        : this.config.cliTimeoutSeconds;
    let removeTemporary = false;
    let preserveTemporary = false;
    if (pending.wavData !== undefined) {
      await mkdir(this.paths.tempDirectory, { recursive: true });
      await writeFile(pending.wavPath, pending.wavData);
      removeTemporary = true;
    }
    try {
      const args = [
        "-m",
        server.modelPath,
        "-f",
        pending.wavPath,
        "-nt",
        "-np",
        "-t",
        String(this.config.whisperThreads),
      ];
      const vadModel = await this.resolvedVadModelPath();
      if (
        vadModel !== null &&
        this.audioDurationMilliseconds(pending.capture) >=
          VAD_ACTIVATION_MILLISECONDS
      ) {
        args.push(
          "--vad",
          "-vm",
          vadModel,
          "-vsd",
          String(VAD_MIN_SILENCE_MILLISECONDS),
          "-vp",
          String(VAD_SPEECH_PAD_MILLISECONDS),
        );
      }
      const result = await this.processSpawner.run(
        this.config.whisperCliBinary,
        args,
        {
          timeoutMilliseconds: timeoutSeconds * 1_000,
          environment: this.cliEnvironment,
        },
      );
      if (result.timedOut) {
        if (result.terminationConfirmed === false) {
          preserveTemporary = true;
          throw new TranscriptionError(
            `whisper-cli timed out after ${Math.trunc(timeoutSeconds)} seconds and could not be terminated; WAV retained at ${pending.wavPath}`,
          );
        }
        throw TranscriptionError.cliTimeout(timeoutSeconds);
      }
      if (result.exitCode !== 0) {
        const details = result.stderr.trim() || result.stdout.trim();
        throw new TranscriptionError(
          details.length === 0
            ? "whisper-cli failed"
            : `whisper-cli failed: ${details}`,
        );
      }
      return normalizeTranscript(result.stdout);
    } finally {
      if (removeTemporary && !preserveTemporary) {
        await rm(pending.wavPath, { force: true }).catch((error: unknown) => this.report(error));
      }
    }
  }

  private async fetchJSONWithTimeout(
    url: string,
    init: RequestInit,
    timeoutSeconds: number,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(TranscriptionError.serverTimeout(timeoutSeconds));
      }, timeoutSeconds * 1_000);
    });
    const request = async (): Promise<unknown> => {
      const response = await this.fetcher(url, {
        ...init,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw TranscriptionError.serverHTTP(response.status);
      }
      return response.json();
    };
    try {
      return await Promise.race([request(), timedOut]);
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof TranscriptionError)) {
        throw TranscriptionError.serverTimeout(timeoutSeconds);
      }
      throw error;
    } finally {
      if (timeout !== null) {
        clearTimeout(timeout);
      }
    }
  }

  private async isServerHealthy(server: ServerConfig): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300);
    try {
      const response = await this.fetcher(
        `http://${this.config.whisperServerHost}:${server.port}/`,
        { method: "GET", signal: controller.signal },
      );
      return response.ok && response.status === 200;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private startupTimeoutSeconds(server: ServerConfig): number {
    return server.profile === "robust" ? server.requestTimeoutSeconds : 15;
  }

  private shouldAttemptCliFallback(
    capture: StoppedCapture,
    diskStatus: DiskSpaceStatus | null,
  ): boolean {
    return (
      diskStatus?.criticalSpace !== true &&
      this.audioDurationMilliseconds(capture) >= 1_500
    );
  }

  private async currentDiskStatus(): Promise<DiskSpaceStatus | null> {
    try {
      return await this.diskStatusProvider(this.paths.tempDirectory);
    } catch {
      return null;
    }
  }

  private userFacingErrorMessage(
    error: unknown,
    diskStatus: DiskSpaceStatus | null,
  ): string {
    if (
      diskStatus !== null &&
      (diskStatus.criticalSpace || isOutOfDiskSpace(error))
    ) {
      return `Disk Almost Full (${diskStatus.summary} free)`;
    }
    return errorMessage(error);
  }

  private async resolvedVadModelPath(): Promise<string | null> {
    const configured = this.config.whisperVADModelPath?.trim() ?? "";
    if (configured.length === 0) {
      return null;
    }
    try {
      await access(configured, fileConstants.R_OK);
      return configured;
    } catch {
      this.report(
        new Error(`Configured VAD model is not readable: ${configured}`),
      );
      return null;
    }
  }

  private async shouldUseVad(capture: StoppedCapture): Promise<boolean> {
    return (
      this.audioDurationMilliseconds(capture) >= VAD_ACTIVATION_MILLISECONDS &&
      (await this.resolvedVadModelPath()) !== null
    );
  }

  private async persistSalvage(
    pending: PendingTranscription,
    diagnostic: TranscriptDiagnostic | null,
  ): Promise<string | null> {
    const stamp = this.clock.now().toISOString().replaceAll(":", "-");
    const base = `whisper-${stamp}-${pending.capture.sessionId}`;
    const wavPath = join(this.paths.salvageDirectory, `${base}.wav`);
    try {
      await mkdir(this.paths.salvageDirectory, { recursive: true });
      if (pending.wavData === undefined) {
        await copyFile(pending.wavPath, wavPath);
      } else {
        await writeFile(wavPath, pending.wavData);
      }
      if (diagnostic !== null) {
        await writeFile(
          join(this.paths.salvageDirectory, `${base}-diagnostics.json`),
          `${JSON.stringify(
            {
              reason: diagnostic.reason,
              sessionId: pending.capture.sessionId,
              rawTranscript: diagnostic.rawTranscript,
              cleanedTranscript: diagnostic.cleanedTranscript,
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
      }
      return wavPath;
    } catch (error) {
      this.report(
        new Error(`Unable to save salvage audio: ${errorMessage(error)}`),
      );
      return null;
    }
  }

  private async persistRecentCapture(
    pending: PendingTranscription,
    text: string,
    mode: string,
    quality: TranscriptQualityAssessment,
  ): Promise<void> {
    const directory = join(this.paths.salvageDirectory, "recent");
    const stamp = this.clock.now().toISOString().replaceAll(":", "-");
    const base = `recent-${stamp}-${pending.capture.sessionId}`;
    const wavPath = join(directory, `${base}.wav`);
    try {
      await mkdir(directory, { recursive: true });
      if (pending.wavData === undefined) {
        await copyFile(pending.wavPath, wavPath);
      } else {
        await writeFile(wavPath, pending.wavData);
      }
      await writeFile(
        join(directory, `${base}.json`),
        `${JSON.stringify(
          {
            sessionId: pending.capture.sessionId,
            completedAtISO8601: this.clock.now().toISOString(),
            transcriptionMode: mode,
            text,
            metrics: this.metrics(pending.capture, mode, null, null),
            captureIntegrity: this.captureIntegrity(pending.capture),
            quality,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await this.cleanupRecentCaptures(directory);
    } catch (error) {
      this.report(
        new Error(`Unable to save recent dictation proof: ${errorMessage(error)}`),
      );
    }
  }

  private async cleanupRecentCaptures(directory: string): Promise<void> {
    const entries = await readdir(directory);
    const wavs = await Promise.all(
      entries
        .filter((entry) => extname(entry) === ".wav")
        .map(async (entry) => ({
          path: join(directory, entry),
          modifiedAt: (await stat(join(directory, entry))).mtimeMs,
        })),
    );
    wavs.sort((left, right) => right.modifiedAt - left.modifiedAt);
    for (const stale of wavs.slice(RECENT_CAPTURE_LIMIT)) {
      await rm(stale.path, { force: true });
      await rm(stale.path.slice(0, -4) + ".json", { force: true });
    }
  }

  private assertRunning(): void {
    if (this.stopped) {
      throw new TranscriptionError("The transcription manager is stopped.");
    }
  }

  private report(error: unknown): void {
    this.errorReporter(
      error instanceof Error ? error : new Error(errorMessage(error)),
    );
  }
}

function normalizeTranscript(text: string): TranscriptOutcome {
  const trimmed = trimFoundationWhitespace(text);
  if (trimmed.length === 0 || isStandalonePlaceholder(trimmed)) {
    return { kind: "no-speech" };
  }
  const stripped = stripPlaceholderArtifacts(trimmed);
  const normalized = stripped.hadArtifacts ? stripped.cleaned : trimmed;
  if (normalized.length === 0 || !/[\p{L}\p{N}]/u.test(normalized)) {
    return { kind: "no-speech" };
  }
  return {
    kind: "text",
    text: normalized,
    diagnostic: stripped.hadArtifacts
      ? {
          reason: "inline-placeholder-artifacts",
          rawTranscript: trimmed,
          cleanedTranscript: normalized,
        }
      : null,
  };
}

function isStandalonePlaceholder(text: string): boolean {
  const marker = text.toUpperCase().replaceAll(/[ _-]/gu, "");
  return [
    "[BLANKAUDIO]",
    "(BLANKAUDIO)",
    "[NOSPEECH]",
    "(NOSPEECH)",
    "[SILENCE]",
    "(SILENCE)",
  ].includes(marker);
}

function stripPlaceholderArtifacts(text: string): {
  cleaned: string;
  hadArtifacts: boolean;
} {
  const marker = /[\[(]\s*(?:BLANK[\s_-]*AUDIO|NO[\s_-]*SPEECH|NOSPEECH|SILENCE)\s*[\])]/giu;
  if (!marker.test(text)) {
    return { cleaned: text, hadArtifacts: false };
  }
  marker.lastIndex = 0;
  const cleaned = text
    .replace(marker, " ")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => trimFoundationWhitespace(line.replaceAll(/[ \t]{2,}/gu, " ")))
    .filter((line) => line.length > 0)
    .join("\n")
    .replaceAll(/[ \t]+([,.;:!?])/gu, "$1");
  return { cleaned: trimFoundationWhitespace(cleaned), hadArtifacts: true };
}

function trimFoundationWhitespace(text: string): string {
  return text.replace(
    /^[\p{White_Space}\u200B]+|[\p{White_Space}\u200B]+$/gu,
    "",
  );
}

function boundedErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  if (message.length <= MAX_ERROR_MESSAGE_LENGTH) {
    return message;
  }
  return `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`;
}

function isOutOfDiskSpace(error: unknown): boolean {
  if (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ENOSPC"
  ) {
    return true;
  }
  const description = errorMessage(error).toLowerCase();
  return (
    description.includes("no space") ||
    description.includes("disk is full") ||
    description.includes("enospc")
  );
}

function commandLineTokens(command: string): string[] {
  const tokens: string[] = [];
  const expression = /"([^"]*)"|'([^']*)'|([^\s]+)/gu;
  for (const match of command.matchAll(expression)) {
    const token = match[1] ?? match[2] ?? match[3];
    if (token !== undefined) {
      tokens.push(token);
    }
  }
  return tokens;
}

function matchesPathComponent(candidate: string, expected: string): boolean {
  const normalizedCandidate = normalizePath(candidate);
  const normalizedExpected = normalizePath(expected);
  return (
    normalizedCandidate === normalizedExpected ||
    pathComponent(normalizedCandidate) === pathComponent(normalizedExpected)
  );
}

function matchesRawCommandExecutable(command: string, expected: string): boolean {
  const normalizedCommand = normalizePath(command.trim());
  const normalizedExpected = normalizePath(expected);
  return commandValueCandidates(normalizedExpected).some((candidate) =>
    hasDelimitedValue(normalizedCommand, candidate, 0),
  );
}

function matchesRawCommandArgument(
  command: string,
  flag: string,
  expected: string,
): boolean {
  const normalizedCommand = normalizePath(command.trim());
  const normalizedExpected = normalizePath(expected);
  return commandValueCandidates(normalizedExpected).some((value) => {
    const candidate = `${flag} ${value}`;
    let offset = normalizedCommand.indexOf(candidate);
    while (offset >= 0) {
      if (hasDelimitedValue(normalizedCommand, candidate, offset)) {
        return true;
      }
      offset = normalizedCommand.indexOf(candidate, offset + 1);
    }
    return false;
  });
}

function commandValueCandidates(value: string): string[] {
  return [value, `"${value}"`, `'${value}'`];
}

function hasDelimitedValue(command: string, value: string, offset: number): boolean {
  const before = offset === 0 ? "" : command[offset - 1];
  const after = command[offset + value.length];
  return (
    (before === "" || /\s/u.test(before ?? "")) &&
    (after === undefined || /\s/u.test(after))
  );
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathComponent(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function formatBytes(bytes: number): string {
  const units = ["bytes", "kB", "MB", "GB", "TB"];
  let value = Math.max(bytes, 0);
  let index = 0;
  while (value >= 1_000 && index < units.length - 1) {
    value /= 1_000;
    index += 1;
  }
  const digits = value >= 10 || index === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index]}`;
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = previous.then(() => gate);
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
}

export { normalizeTranscript };
