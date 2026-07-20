#!/usr/bin/env node

import { copyFile, readFile, readdir, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

const COMMANDS = new Map([
  ["warmup", "warmup"],
  ["start", "start"],
  ["start-robust", "startRobust"],
  ["retry-robust", "retryRobust"],
  ["stop", "stop"],
  ["cancel", "cancel"],
  ["next-result", "nextResult"],
  ["status", "status"],
  ["shutdown", "shutdown"],
  ["open-settings", "openSettings"],
]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const startedAt = performance.now();

try {
  const rawCommand = process.argv[2] ?? "status";
  const configPath = process.env.WDCTL_CONFIG ?? defaultConfigPath();
  const config = await loadConfig(configPath);
  if (rawCommand === "diagnostics") {
    await printDiagnostics(config, process.argv.slice(3));
    process.exitCode = 0;
  } else if (rawCommand === "recoveries") {
    await handleRecoveries(config, process.argv.slice(3));
    process.exitCode = 0;
  } else {
    const command = COMMANDS.get(rawCommand);
    if (command === undefined) {
      throw new Error(`Unknown command '${rawCommand}'`);
    }
  const request = { command };
  if (command === "nextResult" && process.argv[3] !== undefined) {
    request.sessionId = process.argv[3];
  }

  const coldBootMilliseconds = await ensureDaemon(
    command,
    config,
    configPath,
  );
  const response = await sendRequest(request, config, 5_000);
  response.clientObservedMilliseconds = performance.now() - startedAt;
  if (coldBootMilliseconds !== null) {
    response.coldBootMilliseconds = coldBootMilliseconds;
  }
  writeResponse(response);
  process.exitCode = response.ok === true ? 0 : 1;
  }
} catch (error) {
  writeResponse({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    clientObservedMilliseconds: performance.now() - startedAt,
  });
  process.exitCode = 1;
}

async function printDiagnostics(config, args) {
  const sinceIndex = args.indexOf("--since");
  const since = sinceIndex >= 0 ? args[sinceIndex + 1] : "24h";
  if (since !== "24h") {
    throw new Error("diagnostics currently supports only --since 24h.");
  }
  const directory = path.join(path.dirname(config.daemonLogPath), "diagnostics");
  const cutoff = Date.now() - 24 * 60 * 60 * 1_000;
  const records = [];
  for (const entry of (await readdir(directory).catch(() => [])).sort()) {
    if (!entry.startsWith("diagnostics-") || !entry.endsWith(".jsonl")) {
      continue;
    }
    const content = await readFile(path.join(directory, entry), "utf8").catch(() => "");
    for (const line of content.split("\n")) {
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        if (Date.parse(record.timestamp) >= cutoff) records.push(record);
      } catch {
        // Ignore a torn final journal line.
      }
    }
  }
  writeResponse({ ok: true, directory, records });
}

async function handleRecoveries(config, args) {
  const action = args[0] ?? "list";
  const directory = path.join(config.tempDirectory, "recovery");
  if (action === "list") {
    const recoveries = [];
    for (const entry of await readdir(directory).catch(() => [])) {
      if (!entry.endsWith(".json")) continue;
      try {
        const metadata = JSON.parse(await readFile(path.join(directory, entry), "utf8"));
        const wavPath = path.join(directory, `${metadata.sessionId}.wav`);
        const details = await stat(wavPath);
        if (metadata.state !== "active") {
          recoveries.push({ ...metadata, wavPath, fileSizeBytes: details.size });
        }
      } catch {
        // Skip incomplete metadata; startup recovery will reconcile it.
      }
    }
    writeResponse({ ok: true, directory, recoveries });
    return;
  }
  if (action === "export") {
    const sessionId = args[1];
    const destination = args[2];
    if (!sessionId || !/^[a-zA-Z0-9-]+$/.test(sessionId) || !destination) {
      throw new Error("Usage: wdctl recoveries export <session-id> <destination.wav>");
    }
    const source = path.join(directory, `${sessionId}.wav`);
    await copyFile(source, path.resolve(destination));
    writeResponse({ ok: true, sessionId, destination: path.resolve(destination) });
    return;
  }
  throw new Error("Usage: wdctl recoveries list | recoveries export <session-id> <destination.wav>");
}

async function loadConfig(configPath) {
  const parsed = JSON.parse(await readFile(configPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Config must be a JSON object.");
  }
  if (
    typeof parsed.controlHost !== "string" ||
    !LOOPBACK_HOSTS.has(parsed.controlHost.trim().toLowerCase())
  ) {
    throw new Error("controlHost must be loopback-only: 127.0.0.1, localhost, ::1");
  }
  if (
    typeof parsed.controlPort !== "number" ||
    !Number.isSafeInteger(parsed.controlPort) ||
    parsed.controlPort < 1 ||
    parsed.controlPort > 65_535
  ) {
    throw new Error("controlPort must be an integer between 1 and 65535.");
  }
  return parsed;
}

async function ensureDaemon(command, config, configPath) {
  if (command === "shutdown") {
    return null;
  }
  if (await daemonIsReachable(config)) {
    return null;
  }
  if (typeof config.daemonBinaryPath !== "string" || config.daemonBinaryPath === "") {
    throw new Error("The dictation daemon is unreachable and daemonBinaryPath is missing.");
  }

  const coldStart = performance.now();
  const child = await spawnDaemon(config.daemonBinaryPath, configPath);
  child.unref();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await daemonIsReachable(config)) {
      return performance.now() - coldStart;
    }
    await delay(10);
  }
  throw new Error("The dictation daemon did not start in time.");
}

function spawnDaemon(binaryPath, configPath) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binaryPath, ["--config", configPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.once("spawn", () => resolve(child));
    child.once("error", (error) => {
      reject(new Error(`Unable to start the dictation daemon: ${error.message}`));
    });
  });
}

async function daemonIsReachable(config) {
  try {
    await sendRequest({ command: "status" }, config, 150);
    return true;
  } catch {
    return false;
  }
}

function sendRequest(request, config, timeoutMilliseconds) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: config.controlHost,
      port: config.controlPort,
    });
    let response = "";
    let settled = false;

    const finish = (operation) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      operation();
    };

    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMilliseconds);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.length > 8 * 1_024 * 1_024) {
        finish(() => reject(new Error("Control response exceeds 8 MiB.")));
        return;
      }
      const newline = response.indexOf("\n");
      if (newline !== -1) {
        const line = response.slice(0, newline);
        finish(() => {
          try {
            const parsed = JSON.parse(line);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
              throw new Error("Control response must be a JSON object.");
            }
            resolve(parsed);
          } catch (error) {
            reject(error);
          }
        });
      }
    });
    socket.once("timeout", () => {
      finish(() => reject(new Error("Timed out waiting for the dictation daemon.")));
    });
    socket.once("error", (error) => finish(() => reject(error)));
    socket.once("end", () => {
      finish(() => reject(new Error("The dictation daemon closed without a response.")));
    });
  });
}

function defaultConfigPath() {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData === undefined || appData === "") {
      throw new Error("APPDATA is not set.");
    }
    return path.join(appData, "WhisperDictation", "config.json");
  }
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "WhisperDictation",
    "config.json",
  );
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function writeResponse(response) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
