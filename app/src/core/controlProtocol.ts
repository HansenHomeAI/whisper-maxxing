export type TranscriptionProfile = "fast" | "robust";

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
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Unable to decode the control response.");
  }
  const response = value as Record<string, unknown>;
  if (typeof response.ok !== "boolean") {
    throw new Error("Unable to decode the control response.");
  }
  return response as unknown as ControlResponse;
}
