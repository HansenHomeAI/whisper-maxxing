import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  parseAppConfig,
  type AppConfig,
} from "../core/appConfig.js";

export const MAC_MICROPHONE_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
export const MAC_ACCESSIBILITY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

export interface FirstRunConfig extends AppConfig {
  launchAtLogin: boolean;
}

export interface FirstRunPaths {
  homeDirectory: string;
  appDataDirectory: string;
  documentsDirectory: string;
  resourcesDirectory: string;
  executablePath: string;
}

export interface FirstRunOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  paths?: Partial<FirstRunPaths>;
  configPath?: string;
}

export interface FirstRunResult {
  created: boolean;
  configPath: string;
  config: FirstRunConfig;
  permissionLinks: readonly string[];
}

interface WhisperPaths {
  server: string;
  cli: string;
  model: string;
  robustModel: string | null;
  vadModel: string | null;
}

interface WindowsBootstrapOutput {
  serverPath?: unknown;
  cliPath?: unknown;
  modelPath?: unknown;
  smallModelPath?: unknown;
  robustModelPath?: unknown;
}

export function defaultConfigPath(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
): string {
  if (platform === "win32") {
    const appData = requiredEnvironmentDirectory(environment, "APPDATA", homeDirectory);
    return path.win32.join(appData, "WhisperDictation", "config.json");
  }
  return path.join(
    homeDirectory,
    "Library",
    "Application Support",
    "WhisperDictation",
    "config.json",
  );
}

export async function ensureFirstRunConfig(
  options: FirstRunOptions = {},
): Promise<FirstRunResult> {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const resolvedPaths = resolveFirstRunPaths(platform, environment, options.paths);
  const configPath =
    options.configPath ??
    defaultConfigPath(platform, environment, resolvedPaths.homeDirectory);

  try {
    const existing = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    return {
      created: false,
      configPath,
      config: requireFirstRunConfig(existing),
      permissionLinks: permissionLinks(platform),
    };
  } catch (error: unknown) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }

  const whisper = await resolveWhisperPaths(
    platform,
    environment,
    resolvedPaths,
  );
  const config = createDefaultConfig(platform, resolvedPaths, whisper);
  await mkdir(path.dirname(configPath), { recursive: true });
  try {
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error: unknown) {
    if (!isAlreadyExists(error)) {
      throw error;
    }
    const existing = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    return {
      created: false,
      configPath,
      config: requireFirstRunConfig(existing),
      permissionLinks: permissionLinks(platform),
    };
  }

  return {
    created: true,
    configPath,
    config,
    permissionLinks: permissionLinks(platform),
  };
}

export async function openMacPermissionSettings(
  permission: "microphone" | "accessibility",
  openExternal: (url: string) => Promise<unknown>,
): Promise<void> {
  const url =
    permission === "microphone"
      ? MAC_MICROPHONE_SETTINGS_URL
      : MAC_ACCESSIBILITY_SETTINGS_URL;
  await openExternal(url);
}

function createDefaultConfig(
  platform: NodeJS.Platform,
  paths: FirstRunPaths,
  whisper: WhisperPaths,
): FirstRunConfig {
  const separator = platform === "win32" ? path.win32 : path;
  const dataDirectory = separator.join(paths.appDataDirectory, "WhisperDictation");
  const logsDirectory = separator.join(dataDirectory, "logs");
  return {
    controlHost: "127.0.0.1",
    controlPort: 44_124,
    preferredInputDevice: null,
    enforcePreferredInputDevice: false,
    macCaptureBackend: "native",
    prebufferMilliseconds: 1_000,
    audioBufferSizeFrames: 128,
    pollIntervalMilliseconds: 150,
    whisperServerBinary: whisper.server,
    whisperCliBinary: whisper.cli,
    whisperModelPath: whisper.model,
    whisperVADModelPath: whisper.vadModel,
    whisperServerHost: "127.0.0.1",
    whisperServerPort: 8_179,
    whisperRobustModelPath: whisper.robustModel,
    robustWhisperServerPort: 8_180,
    tempDirectory: separator.join(dataDirectory, "cache"),
    salvageDirectory: separator.join(paths.documentsDirectory, "WhisperSalvage"),
    daemonLogPath: separator.join(logsDirectory, "daemon.log"),
    whisperServerLogPath: separator.join(logsDirectory, "whisper-server.log"),
    controlBinaryPath: separator.join(paths.resourcesDirectory, "bin", "wdctl.mjs"),
    daemonBinaryPath: paths.executablePath,
    warmServerOnLaunch: true,
    warmRobustServerOnLaunch: false,
    whisperThreads: 4,
    persistRecentCaptures: false,
    persistHistory: true,
    serverRequestTimeoutSeconds: 30,
    robustServerRequestTimeoutSeconds: 120,
    cliTimeoutSeconds: 90,
    launchAtLogin: true,
  };
}

async function resolveWhisperPaths(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  paths: FirstRunPaths,
): Promise<WhisperPaths> {
  const bootstrap = await readWindowsBootstrap(environment);
  const defaults = defaultWhisperPaths(platform, environment, paths);
  return {
    server:
      nonempty(environment.WHISPER_SERVER_BINARY) ??
      stringField(bootstrap, "serverPath") ??
      defaults.server,
    cli:
      nonempty(environment.WHISPER_CLI_BINARY) ??
      stringField(bootstrap, "cliPath") ??
      defaults.cli,
    model:
      nonempty(environment.WHISPER_MODEL_PATH) ??
      stringField(bootstrap, "modelPath") ??
      stringField(bootstrap, "smallModelPath") ??
      defaults.model,
    robustModel:
      nonempty(environment.WHISPER_ROBUST_MODEL_PATH) ??
      stringField(bootstrap, "robustModelPath") ??
      defaults.robustModel,
    vadModel: nonempty(environment.WHISPER_VAD_MODEL_PATH) ?? null,
  };
}

function defaultWhisperPaths(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  paths: FirstRunPaths,
): WhisperPaths {
  if (platform === "win32") {
    const root =
      nonempty(environment.WHISPER_CPP_ROOT) ??
      path.win32.join(
        requiredEnvironmentDirectory(
          environment,
          "LOCALAPPDATA",
          paths.homeDirectory,
        ),
        "WhisperDictation",
        "whisper.cpp",
      );
    return {
      server: path.win32.join(root, "build", "bin", "Release", "whisper-server.exe"),
      cli: path.win32.join(root, "build", "bin", "Release", "whisper-cli.exe"),
      model: path.win32.join(root, "models", "ggml-small.en.bin"),
      robustModel: null,
      vadModel: null,
    };
  }

  const supportDirectory = path.join(
    paths.homeDirectory,
    "Library",
    "Application Support",
    "WhisperDictation",
  );
  return {
    server: path.join(supportDirectory, "whisper.cpp", "bin", "whisper-server"),
    cli: path.join(supportDirectory, "whisper.cpp", "bin", "whisper-cli"),
    model: path.join(supportDirectory, "models", "ggml-small.en.bin"),
    robustModel: null,
    vadModel: null,
  };
}

async function readWindowsBootstrap(
  environment: NodeJS.ProcessEnv,
): Promise<WindowsBootstrapOutput | null> {
  const source = nonempty(environment.WHISPER_SETUP_JSON);
  if (source === undefined) {
    return null;
  }
  let content = source;
  if (!source.trimStart().startsWith("{")) {
    content = await readFile(source, "utf8");
  }
  const parsed = JSON.parse(content) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("WHISPER_SETUP_JSON must contain a JSON object.");
  }
  return parsed as WindowsBootstrapOutput;
}

function resolveFirstRunPaths(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  overrides: Partial<FirstRunPaths> | undefined,
): FirstRunPaths {
  const homeDirectory = overrides?.homeDirectory ?? os.homedir();
  const appDataDirectory =
    overrides?.appDataDirectory ??
    (platform === "win32"
      ? requiredEnvironmentDirectory(environment, "APPDATA", homeDirectory)
      : path.join(homeDirectory, "Library", "Application Support"));
  const documentsDirectory =
    overrides?.documentsDirectory ??
    (platform === "win32"
      ? path.win32.join(homeDirectory, "Documents")
      : path.join(homeDirectory, "Documents"));
  return {
    homeDirectory,
    appDataDirectory,
    documentsDirectory,
    resourcesDirectory: overrides?.resourcesDirectory ?? process.resourcesPath,
    executablePath: overrides?.executablePath ?? process.execPath,
  };
}

function requireFirstRunConfig(value: unknown): FirstRunConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("config must be an object");
  }
  const config = value as Record<string, unknown>;
  const launchAtLogin = config.launchAtLogin;
  if (launchAtLogin !== undefined && typeof launchAtLogin !== "boolean") {
    throw new Error("launchAtLogin must be a boolean");
  }
  return {
    ...parseAppConfig(config),
    launchAtLogin: launchAtLogin !== false,
  };
}

function permissionLinks(platform: NodeJS.Platform): readonly string[] {
  return platform === "darwin"
    ? [MAC_MICROPHONE_SETTINGS_URL, MAC_ACCESSIBILITY_SETTINGS_URL]
    : [];
}

function stringField(
  source: WindowsBootstrapOutput | null,
  field: keyof WindowsBootstrapOutput,
): string | undefined {
  return nonempty(source?.[field]);
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function requiredEnvironmentDirectory(
  environment: NodeJS.ProcessEnv,
  key: "APPDATA" | "LOCALAPPDATA",
  homeDirectory: string,
): string {
  return nonempty(environment[key]) ?? path.win32.join(homeDirectory, "AppData", key === "APPDATA" ? "Roaming" : "Local");
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

export async function assertWhisperInputsReadable(config: FirstRunConfig): Promise<void> {
  const required = [
    config.whisperServerBinary,
    config.whisperCliBinary,
    config.whisperModelPath,
  ];
  for (const input of required) {
    await access(input, constants.R_OK);
  }
}
