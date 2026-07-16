export type TranscriptionProfile = "fast" | "robust";
export type CaptureBackend = "native-macos" | "electron-renderer";

export const CONTROL_COMMANDS = [
  "warmup",
  "start",
  "startRobust",
  "retryRobust",
  "stop",
  "cancel",
  "nextResult",
  "status",
  "shutdown",
  "openSettings",
] as const;

export type ControlCommand = (typeof CONTROL_COMMANDS)[number];

export interface ControlRequest {
  command: ControlCommand;
  sessionId?: string | null;
}

export interface SessionMetrics {
  sessionId: string;
  transcriptionProfile?: string | null;
  prebufferMilliseconds: number;
  audioDurationMilliseconds: number;
  captureStartedAtISO8601?: string | null;
  captureStoppedAtISO8601?: string | null;
  captureWallClockMilliseconds?: number | null;
  activeAudioMilliseconds?: number | null;
  captureDroppedMilliseconds?: number | null;
  captureCoverageRatio?: number | null;
  transcriptionMode?: string | null;
  transcriptionMilliseconds?: number | null;
  queueWaitMilliseconds?: number | null;
  completedAtISO8601?: string | null;
}

export interface SessionResultPayload {
  sessionId: string;
  text: string;
  metrics: SessionMetrics;
  salvagePath?: string | null;
  errorMessage?: string | null;
}

export interface StatusPayload {
  recording: boolean;
  recordingProfile?: string | null;
  pendingCount: number;
  engineReady: boolean;
  engineHealthMessage?: string | null;
  engineStartupMilliseconds?: number | null;
  prebufferAvailableMilliseconds: number;
  preferredInputDevice?: string | null;
  defaultInputDevice?: string | null;
  captureBackend?: CaptureBackend | null;
  serverState: string;
  robustServerState?: string | null;
  availableDiskSpaceBytes?: number | null;
  lowDiskSpaceMessage?: string | null;
}

export interface ControlResponse {
  ok: boolean;
  error?: string | null;
  recording?: boolean | null;
  pendingCount?: number | null;
  sessionId?: string | null;
  resultAvailable?: boolean | null;
  result?: SessionResultPayload | null;
  status?: StatusPayload | null;
  clientObservedMilliseconds?: number | null;
  coldBootMilliseconds?: number | null;
}

export function decodeControlRequest(value: unknown): ControlRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Unable to decode the control response.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.command !== "string" ||
    !CONTROL_COMMANDS.some((command) => command === candidate.command)
  ) {
    throw new Error("Unable to decode the control response.");
  }
  if (
    candidate.sessionId !== undefined &&
    candidate.sessionId !== null &&
    typeof candidate.sessionId !== "string"
  ) {
    throw new Error("Unable to decode the control response.");
  }

  const request: ControlRequest = { command: candidate.command as ControlCommand };
  if (candidate.sessionId === null || typeof candidate.sessionId === "string") {
    request.sessionId = candidate.sessionId;
  }
  return request;
}

export function decodeControlResponse(value: unknown): ControlResponse {
  const response = requireObject(value);
  requireBoolean(response, "ok");
  optional(response, "error", requireStringValue);
  optional(response, "recording", requireBooleanValue);
  optional(response, "pendingCount", requireIntegerValue);
  optional(response, "sessionId", requireStringValue);
  optional(response, "resultAvailable", requireBooleanValue);
  optional(response, "result", validateSessionResult);
  optional(response, "status", validateStatus);
  optional(response, "clientObservedMilliseconds", requireNumberValue);
  optional(response, "coldBootMilliseconds", requireNumberValue);
  return response as unknown as ControlResponse;
}

function validateSessionResult(value: unknown): void {
  const result = requireObject(value);
  requireString(result, "sessionId");
  requireString(result, "text");
  validateSessionMetrics(requireField(result, "metrics"));
  optional(result, "salvagePath", requireStringValue);
  optional(result, "errorMessage", requireStringValue);
}

function validateSessionMetrics(value: unknown): void {
  const metrics = requireObject(value);
  requireString(metrics, "sessionId");
  requireNumber(metrics, "prebufferMilliseconds");
  requireNumber(metrics, "audioDurationMilliseconds");
  optional(metrics, "transcriptionProfile", requireStringValue);
  optional(metrics, "captureStartedAtISO8601", requireStringValue);
  optional(metrics, "captureStoppedAtISO8601", requireStringValue);
  optional(metrics, "captureWallClockMilliseconds", requireNumberValue);
  optional(metrics, "activeAudioMilliseconds", requireNumberValue);
  optional(metrics, "captureDroppedMilliseconds", requireNumberValue);
  optional(metrics, "captureCoverageRatio", requireNumberValue);
  optional(metrics, "transcriptionMode", requireStringValue);
  optional(metrics, "transcriptionMilliseconds", requireNumberValue);
  optional(metrics, "queueWaitMilliseconds", requireNumberValue);
  optional(metrics, "completedAtISO8601", requireStringValue);
}

function validateStatus(value: unknown): void {
  const status = requireObject(value);
  requireBoolean(status, "recording");
  requireInteger(status, "pendingCount");
  requireBoolean(status, "engineReady");
  requireNumber(status, "prebufferAvailableMilliseconds");
  requireString(status, "serverState");
  optional(status, "recordingProfile", requireStringValue);
  optional(status, "engineHealthMessage", requireStringValue);
  optional(status, "engineStartupMilliseconds", requireNumberValue);
  optional(status, "preferredInputDevice", requireStringValue);
  optional(status, "defaultInputDevice", requireStringValue);
  optional(status, "captureBackend", requireCaptureBackendValue);
  optional(status, "robustServerState", requireStringValue);
  optional(status, "availableDiskSpaceBytes", requireIntegerValue);
  optional(status, "lowDiskSpaceMessage", requireStringValue);
}

type JsonObject = Record<string, unknown>;

function decodingError(): Error {
  return new Error("Unable to decode the control response.");
}

function requireObject(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw decodingError();
  }
  return value as JsonObject;
}

function requireField(source: JsonObject, field: string): unknown {
  if (!(field in source) || source[field] === null || source[field] === undefined) {
    throw decodingError();
  }
  return source[field];
}

function requireString(source: JsonObject, field: string): void {
  requireStringValue(requireField(source, field));
}

function requireBoolean(source: JsonObject, field: string): void {
  requireBooleanValue(requireField(source, field));
}

function requireNumber(source: JsonObject, field: string): void {
  requireNumberValue(requireField(source, field));
}

function requireInteger(source: JsonObject, field: string): void {
  requireIntegerValue(requireField(source, field));
}

function optional(
  source: JsonObject,
  field: string,
  validate: (value: unknown) => void,
): void {
  const value = source[field];
  if (value !== undefined && value !== null) {
    validate(value);
  }
}

function requireStringValue(value: unknown): void {
  if (typeof value !== "string") {
    throw decodingError();
  }
}

function requireCaptureBackendValue(value: unknown): void {
  if (value !== "native-macos" && value !== "electron-renderer") {
    throw decodingError();
  }
}

function requireBooleanValue(value: unknown): void {
  if (typeof value !== "boolean") {
    throw decodingError();
  }
}

function requireNumberValue(value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw decodingError();
  }
}

function requireIntegerValue(value: unknown): void {
  requireNumberValue(value);
  if (!Number.isSafeInteger(value)) {
    throw decodingError();
  }
}
