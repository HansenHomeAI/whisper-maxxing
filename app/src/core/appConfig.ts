export const DEFAULT_PERSIST_RECENT_CAPTURES = false;
export const DEFAULT_PERSIST_HISTORY = true;
export const DEFAULT_SERVER_REQUEST_TIMEOUT_SECONDS = 30;
export const DEFAULT_ROBUST_SERVER_REQUEST_TIMEOUT_SECONDS = 120;
export const DEFAULT_CLI_TIMEOUT_SECONDS = 90;
export const DEFAULT_ROBUST_WHISPER_SERVER_PORT = 8_178;
export const DEFAULT_WARM_ROBUST_SERVER_ON_LAUNCH = false;
export const DEFAULT_MAC_CAPTURE_BACKEND = "native" as const;
export const ALLOWED_CONTROL_HOSTS = ["127.0.0.1", "localhost", "::1"] as const;

export type MacCaptureBackend = "native" | "electron";

export interface AppConfig {
  controlHost: string;
  controlPort: number;
  preferredInputDevice: string | null;
  enforcePreferredInputDevice: boolean;
  macCaptureBackend?: MacCaptureBackend;
  prebufferMilliseconds: number;
  audioBufferSizeFrames: number;
  pollIntervalMilliseconds: number;
  whisperServerBinary: string;
  whisperCliBinary: string;
  whisperModelPath: string;
  whisperVADModelPath: string | null;
  whisperServerHost: string;
  whisperServerPort: number;
  whisperRobustModelPath: string | null;
  robustWhisperServerPort: number;
  tempDirectory: string;
  salvageDirectory: string;
  daemonLogPath: string;
  whisperServerLogPath: string;
  controlBinaryPath: string;
  daemonBinaryPath: string;
  warmServerOnLaunch: boolean;
  warmRobustServerOnLaunch: boolean;
  whisperThreads: number;
  persistRecentCaptures: boolean;
  persistHistory: boolean;
  serverRequestTimeoutSeconds: number;
  robustServerRequestTimeoutSeconds: number;
  cliTimeoutSeconds: number;
}

export interface AppPaths {
  tempDirectory: string;
  salvageDirectory: string;
  daemonLogPath: string;
  whisperServerLogPath: string;
  robustWhisperServerLogPath: string;
}

export function isLoopbackControlHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return ALLOWED_CONTROL_HOSTS.some((allowed) => allowed === normalized);
}

export function parseAppConfig(value: unknown): AppConfig {
  const source = requireObject(value, "config");
  const controlHost = requireString(source, "controlHost");
  if (!isLoopbackControlHost(controlHost)) {
    throw new Error(
      `controlHost must be loopback-only: ${ALLOWED_CONTROL_HOSTS.join(", ")}`,
    );
  }

  const serverRequestTimeoutSeconds = optionalNumber(
    source,
    "serverRequestTimeoutSeconds",
    DEFAULT_SERVER_REQUEST_TIMEOUT_SECONDS,
  );
  const robustServerRequestTimeoutSeconds = optionalNumber(
    source,
    "robustServerRequestTimeoutSeconds",
    DEFAULT_ROBUST_SERVER_REQUEST_TIMEOUT_SECONDS,
  );
  const cliTimeoutSeconds = optionalNumber(
    source,
    "cliTimeoutSeconds",
    DEFAULT_CLI_TIMEOUT_SECONDS,
  );
  requirePositive(serverRequestTimeoutSeconds, "serverRequestTimeoutSeconds");
  requirePositive(
    robustServerRequestTimeoutSeconds,
    "robustServerRequestTimeoutSeconds",
  );
  requirePositive(cliTimeoutSeconds, "cliTimeoutSeconds");

  return {
    controlHost,
    controlPort: requireInteger(source, "controlPort"),
    preferredInputDevice: optionalNullableString(source, "preferredInputDevice"),
    enforcePreferredInputDevice: requireBoolean(
      source,
      "enforcePreferredInputDevice",
    ),
    macCaptureBackend: optionalMacCaptureBackend(source),
    prebufferMilliseconds: requireInteger(source, "prebufferMilliseconds"),
    audioBufferSizeFrames: requireInteger(source, "audioBufferSizeFrames"),
    pollIntervalMilliseconds: requireInteger(source, "pollIntervalMilliseconds"),
    whisperServerBinary: requireString(source, "whisperServerBinary"),
    whisperCliBinary: requireString(source, "whisperCliBinary"),
    whisperModelPath: requireString(source, "whisperModelPath"),
    whisperVADModelPath: optionalNullableString(source, "whisperVADModelPath"),
    whisperServerHost: requireString(source, "whisperServerHost"),
    whisperServerPort: requireInteger(source, "whisperServerPort"),
    whisperRobustModelPath: optionalNullableString(
      source,
      "whisperRobustModelPath",
    ),
    robustWhisperServerPort: optionalInteger(
      source,
      "robustWhisperServerPort",
      DEFAULT_ROBUST_WHISPER_SERVER_PORT,
    ),
    tempDirectory: requireString(source, "tempDirectory"),
    salvageDirectory: requireString(source, "salvageDirectory"),
    daemonLogPath: requireString(source, "daemonLogPath"),
    whisperServerLogPath: requireString(source, "whisperServerLogPath"),
    controlBinaryPath: requireString(source, "controlBinaryPath"),
    daemonBinaryPath: requireString(source, "daemonBinaryPath"),
    warmServerOnLaunch: requireBoolean(source, "warmServerOnLaunch"),
    warmRobustServerOnLaunch: optionalBoolean(
      source,
      "warmRobustServerOnLaunch",
      DEFAULT_WARM_ROBUST_SERVER_ON_LAUNCH,
    ),
    whisperThreads: requireInteger(source, "whisperThreads"),
    persistRecentCaptures: optionalBoolean(
      source,
      "persistRecentCaptures",
      DEFAULT_PERSIST_RECENT_CAPTURES,
    ),
    persistHistory: optionalBoolean(
      source,
      "persistHistory",
      DEFAULT_PERSIST_HISTORY,
    ),
    serverRequestTimeoutSeconds,
    robustServerRequestTimeoutSeconds,
    cliTimeoutSeconds,
  };
}

function optionalMacCaptureBackend(source: JsonObject): MacCaptureBackend {
  const value = source.macCaptureBackend;
  if (value === undefined || value === null) {
    return DEFAULT_MAC_CAPTURE_BACKEND;
  }
  if (value !== "native" && value !== "electron") {
    throw new Error("macCaptureBackend must be native or electron");
  }
  return value;
}

export function appPaths(config: AppConfig): AppPaths {
  return {
    tempDirectory: config.tempDirectory,
    salvageDirectory: config.salvageDirectory,
    daemonLogPath: config.daemonLogPath,
    whisperServerLogPath: config.whisperServerLogPath,
    robustWhisperServerLogPath: robustLogPath(config.whisperServerLogPath),
  };
}

function robustLogPath(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const directory = path.slice(0, separatorIndex + 1);
  const filename = path.slice(separatorIndex + 1);
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex <= 0) {
    return `${directory}${filename}-robust`;
  }
  return `${directory}${filename.slice(0, dotIndex)}-robust${filename.slice(dotIndex)}`;
}

type JsonObject = Record<string, unknown>;

function requireObject(value: unknown, field: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as JsonObject;
}

function requireString(source: JsonObject, field: string): string {
  const value = source[field];
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  return value;
}

function optionalNullableString(source: JsonObject, field: string): string | null {
  const value = source[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string or null`);
  }
  return value;
}

function requireNumber(source: JsonObject, field: string): number {
  const value = source[field];
  if (typeof value !== "number") {
    throw new Error(`${field} must be a number`);
  }
  return value;
}

function requireInteger(source: JsonObject, field: string): number {
  const value = requireNumber(source, field);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${field} must be an integer`);
  }
  return value;
}

function optionalNumber(
  source: JsonObject,
  field: string,
  defaultValue: number,
): number {
  const value = source[field];
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value !== "number") {
    throw new Error(`${field} must be a number`);
  }
  return value;
}

function optionalInteger(
  source: JsonObject,
  field: string,
  defaultValue: number,
): number {
  const value = source[field];
  if (value === undefined || value === null) {
    return defaultValue;
  }
  return requireInteger(source, field);
}

function requireBoolean(source: JsonObject, field: string): boolean {
  const value = source[field];
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function optionalBoolean(
  source: JsonObject,
  field: string,
  defaultValue: boolean,
): boolean {
  const value = source[field];
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function requirePositive(value: number, field: string): void {
  if (value <= 0) {
    throw new Error(`${field} must be positive`);
  }
}
