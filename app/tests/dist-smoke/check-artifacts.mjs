import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const appRoot = path.resolve(import.meta.dirname, "../..");
const releaseRoot = path.join(appRoot, "release");
const packageJson = JSON.parse(
  await readFile(path.join(appRoot, "package.json"), "utf8"),
);

const artifacts = await listReleaseEntries(releaseRoot);
const expectedArchive = process.platform === "darwin" ? ".dmg" : ".exe";
const expectedSecondArchive = process.platform === "darwin" ? ".zip" : null;
requireMatchingArtifact(artifacts, expectedArchive);
if (expectedSecondArchive !== null) {
  requireMatchingArtifact(artifacts, expectedSecondArchive);
}

const binary = packagedBinary(releaseRoot);
const output = execFileSync(binary, ["--version"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 30_000,
}).trim();
if (!output.includes(packageJson.version)) {
  throw new Error(
    `Packaged binary version mismatch: expected ${packageJson.version}, received ${JSON.stringify(output)}`,
  );
}

await verifyCompiledSetup();
console.log(`Artifact smoke passed: ${path.relative(appRoot, binary)} --version => ${output}`);

async function verifyCompiledSetup() {
  const { ensureFirstRunConfig, MAC_ACCESSIBILITY_SETTINGS_URL, MAC_MICROPHONE_SETTINGS_URL } =
    await import(path.join(appRoot, "dist-electron/main/firstRun.js"));
  const { configureLaunchAtLogin } = await import(
    path.join(appRoot, "dist-electron/main/loginItem.js")
  );
  const temporary = await mkdtemp(path.join(os.tmpdir(), "whisper-dist-smoke-"));
  try {
    const configPath = path.join(temporary, "config.json");
    const result = await ensureFirstRunConfig({
      platform: "darwin",
      environment: {
        WHISPER_SERVER_BINARY: "/whisper/server",
        WHISPER_CLI_BINARY: "/whisper/cli",
        WHISPER_MODEL_PATH: "/whisper/model.bin",
      },
      configPath,
      paths: {
        homeDirectory: temporary,
        appDataDirectory: path.join(temporary, "support"),
        documentsDirectory: path.join(temporary, "documents"),
        resourcesDirectory: path.join(temporary, "resources"),
        executablePath: binary,
      },
    });
    if (!result.created || result.config.controlPort !== 44_124 || result.config.whisperServerPort !== 8_179 || result.config.robustWhisperServerPort !== 8_180) {
      throw new Error("First-run config did not use the Electron coexistence defaults.");
    }
    if (
      result.permissionLinks[0] !== MAC_MICROPHONE_SETTINGS_URL ||
      result.permissionLinks[1] !== MAC_ACCESSIBILITY_SETTINGS_URL
    ) {
      throw new Error("First-run config omitted the macOS permission deep-links.");
    }
    const second = await ensureFirstRunConfig({ platform: "darwin", configPath });
    if (second.created) {
      throw new Error("First-run config overwrote an existing config.");
    }

    const windowsConfig = await ensureFirstRunConfig({
      platform: "win32",
      environment: {
        WHISPER_SETUP_JSON: JSON.stringify({
          serverPath: "C:\\Whisper\\whisper-server.exe",
          cliPath: "C:\\Whisper\\whisper-cli.exe",
          smallModelPath: "C:\\Whisper\\ggml-small.en.bin",
          robustModelPath: "C:\\Whisper\\ggml-large-v3.bin",
        }),
      },
      configPath: path.join(temporary, "windows-config.json"),
      paths: {
        homeDirectory: "C:\\Users\\smoke",
        appDataDirectory: "C:\\Users\\smoke\\AppData\\Roaming",
        documentsDirectory: "C:\\Users\\smoke\\Documents",
        resourcesDirectory: "C:\\Program Files\\Whisper Maxxing\\resources",
        executablePath: "C:\\Program Files\\Whisper Maxxing\\Whisper Maxxing.exe",
      },
    });
    if (
      windowsConfig.config.whisperServerBinary !== "C:\\Whisper\\whisper-server.exe" ||
      windowsConfig.config.whisperModelPath !== "C:\\Whisper\\ggml-small.en.bin" ||
      windowsConfig.config.whisperRobustModelPath !== "C:\\Whisper\\ggml-large-v3.bin"
    ) {
      throw new Error("First-run config ignored setup-whisper-windows JSON output.");
    }

    let configured = null;
    configureLaunchAtLogin(
      {
        setLoginItemSettings(settings) {
          configured = settings.openAtLogin;
        },
        getLoginItemSettings() {
          return { openAtLogin: configured };
        },
      },
      { launchAtLogin: false },
      "win32",
    );
    if (configured !== false) {
      throw new Error("Launch-at-login config toggle was ignored.");
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function listReleaseEntries(root) {
  const { readdir } = await import("node:fs/promises");
  return readdir(root, { recursive: true });
}

function requireMatchingArtifact(entries, extension) {
  if (!entries.some((entry) => entry.toLowerCase().endsWith(extension))) {
    throw new Error(`Missing ${extension} artifact under ${releaseRoot}`);
  }
}

function packagedBinary(root) {
  if (process.platform === "darwin") {
    const unpacked = process.arch === "arm64" ? "mac-arm64" : "mac";
    return path.join(
      root,
      unpacked,
      "Whisper Maxxing.app",
      "Contents",
      "MacOS",
      "Whisper Maxxing",
    );
  }
  if (process.platform === "win32") {
    return path.join(root, "win-unpacked", "Whisper Maxxing.exe");
  }
  throw new Error(`Unsupported artifact smoke platform: ${process.platform}`);
}
