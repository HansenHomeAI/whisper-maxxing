import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { appendFileSync, openSync, closeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  sendControl,
  sleep,
  type ControlTarget,
} from "./controlClient.js";

export interface ManagedElectronTarget {
  transcriptNonce: string;
  stop(): Promise<void>;
}

export async function startManagedElectronTarget(
  target: ControlTarget,
): Promise<ManagedElectronTarget | null> {
  if (target.target !== "electron") {
    return null;
  }
  if (process.env.WD_EXTERNAL_TARGET === "1") {
    return null;
  }
  const appRoot = path.resolve(import.meta.dirname, "../../..");
  const transcriptNonce = randomUUID();
  buildProductionApp(appRoot);
  const root = await mkdtemp(path.join(os.tmpdir(), "whisper-electron-e2e-"));
  const tempDirectory = path.join(root, "captures");
  const salvageDirectory = path.join(root, "salvage");
  const logDirectory = path.join(root, "logs");
  const modelDirectory = path.join(root, "models");
  await Promise.all(
    [tempDirectory, salvageDirectory, logDirectory, modelDirectory].map(
      (directory) => mkdir(directory, { recursive: true }),
    ),
  );
  const fastModel = path.join(modelDirectory, "fast.bin");
  const robustModel = path.join(modelDirectory, "robust.bin");
  await Promise.all([writeFile(fastModel, "fake"), writeFile(robustModel, "fake")]);
  const fakeServer = path.join(
    appRoot,
    "tests",
    "e2e",
    "protocol",
    "fake-whisper-server.mjs",
  );
  const configPath = path.join(root, "config.json");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        controlHost: target.host,
        controlPort: target.port,
        preferredInputDevice: "Fake Default Audio Input",
        enforcePreferredInputDevice: false,
        macCaptureBackend: "electron",
        prebufferMilliseconds: 1_000,
        audioBufferSizeFrames: 128,
        pollIntervalMilliseconds: 150,
        whisperServerBinary: fakeServer,
        whisperCliBinary: path.join(appRoot, "tests", "fakes", "fake-whisper-cli.mjs"),
        whisperModelPath: fastModel,
        whisperVADModelPath: null,
        whisperServerHost: "127.0.0.1",
        whisperServerPort: target.port + 10_000,
        whisperRobustModelPath: robustModel,
        robustWhisperServerPort: target.port + 10_001,
        tempDirectory,
        salvageDirectory,
        daemonLogPath: path.join(logDirectory, "daemon.log"),
        whisperServerLogPath: path.join(logDirectory, "whisper-server.log"),
        controlBinaryPath: "unused",
        daemonBinaryPath: "unused",
        warmServerOnLaunch: true,
        warmRobustServerOnLaunch: false,
        whisperThreads: 2,
        persistRecentCaptures: false,
        persistHistory: false,
        launchAtLogin: false,
        serverRequestTimeoutSeconds: 5,
        robustServerRequestTimeoutSeconds: 5,
        cliTimeoutSeconds: 5,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const logPath = path.join(root, "electron.log");
  const logFd = openSync(logPath, "a");
  const require = createRequire(import.meta.url);
  const electronBinary = require("electron") as string;
  const fakeAudio = path.join(
    appRoot,
    "tests",
    "fixtures",
    "audio",
    "prebuffer-marker.wav",
  );
  const args = [
    appRoot,
    `--user-data-dir=${path.join(root, "user-data")}`,
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${fakeAudio}`,
  ];
  if (process.platform === "darwin") {
    args.push("--no-sandbox");
  }
  const child = spawn(electronBinary, args, {
    cwd: appRoot,
    env: {
      ...process.env,
      WD_CONFIG: configPath,
      WD_HEADLESS: "1",
      WD_NODE_BINARY: process.execPath,
      WD_E2E_TRANSCRIPT_NONCE: transcriptNonce,
    },
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  child.once("exit", (code, signal) => {
    appendFileSync(
      logPath,
      `\n[harness] Electron exited code=${String(code)} signal=${String(signal)}\n`,
    );
  });
  let stopped = false;
  try {
    await waitForListener(target, child, logPath);
  } catch (error) {
    await stopChild(child);
    closeSync(logFd);
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  return {
    transcriptNonce,
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      await sendControl(target, "shutdown").catch(() => undefined);
      await stopChild(child);
      closeSync(logFd);
      if (process.env.WD_E2E_KEEP_ARTIFACTS === "1") {
        process.stderr.write(`Electron E2E artifacts: ${root}\n`);
      } else {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

function buildProductionApp(appRoot: string): void {
  const npmCli = process.env.npm_execpath?.trim();
  const node = process.env.npm_node_execpath?.trim() || process.execPath;
  const command = npmCli ? node : process.platform === "win32" ? "npm.cmd" : "npm";
  const args = npmCli ? [npmCli, "run", "build"] : ["run", "build"];
  const result = spawnSync(command, args, {
    cwd: appRoot,
    env: process.env,
    stdio: "inherit",
    shell: npmCli ? false : process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(
      `Production Electron build failed with status ${String(result.status)}: ${result.error?.message ?? "no spawn error"}`,
    );
  }
}

async function waitForListener(
  target: ControlTarget,
  child: ChildProcess,
  logPath: string,
): Promise<void> {
  const deadline = Date.now() + target.resultTimeoutMilliseconds;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Electron exited before readiness (${child.exitCode}); log: ${logPath}`,
      );
    }
    try {
      const response = await sendControl(target, "status");
      if (response.ok) {
        return;
      }
    } catch {
      // Binding and capture readiness are independently checked by the protocol suite.
    }
    await sleep(100);
  }
  throw new Error(`Electron did not bind ${target.host}:${target.port}; log: ${logPath}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const graceful = await Promise.race([
    exited.then(() => true),
    sleep(8_000).then(() => false),
  ]);
  if (graceful) {
    return;
  }
  child.kill("SIGKILL");
  await Promise.race([exited, sleep(2_000)]);
}
