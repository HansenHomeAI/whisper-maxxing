import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

if (process.platform !== "darwin") throw new Error("live gate requires macOS");
const appRoot = path.resolve(import.meta.dirname, "../../..");
const repoRoot = path.resolve(appRoot, "..");
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
const artifactRoot = path.join(appRoot, "test-results", "macos-native-capture", head);
await mkdir(artifactRoot, { recursive: true });
const probe = path.join(artifactRoot, "MacAcceptanceProbe");
const source = path.join(import.meta.dirname, "MacAcceptanceProbe.swift");
run("xcrun", ["swiftc", source, "-o", probe, "-framework", "AppKit", "-framework", "ApplicationServices", "-framework", "CoreGraphics", "-framework", "ImageIO", "-framework", "Vision"]);
run(probe, ["preflight"]);

const existing = spawnSync("pgrep", ["-x", "Whisper Maxxing"], { encoding: "utf8" });
if (existing.status === 0 && existing.stdout.trim()) {
  throw new Error("Quit existing Whisper Maxxing instances before the live gate");
}

const baseline = path.join(artifactRoot, "baseline.png");
const electronControl = path.join(artifactRoot, "electron-control.png");
const nativeTarget = path.join(artifactRoot, "native-target.png");
captureMenu(baseline);

const control = await launchTarget("electron", false);
await waitForReady(control);
captureMenu(electronControl);
await stopTarget(control);

const native = await launchTarget("native", false);
const nativeStatus = await waitForReady(native);
captureMenu(nativeTarget);
await send(native.port, "openSettings");
await sleep(600);
run(probe, ["dictation-shortcut"]);
await waitForRecording(native, true);
await sleep(500);
run(probe, ["dictation-shortcut"]);
const sessionId = await waitForStoppedSession(native);
const result = await waitForResult(native, sessionId);
if (!result.text.includes(native.nonce)) throw new Error(`nonce missing from result: ${result.text}`);
const historyPath = path.join(native.userData, "history.jsonl");
await waitForFileText(historyPath, native.nonce);
const historyLines = (await readFile(historyPath, "utf8")).split("\n").filter((line) => line.includes(native.nonce));
if (historyLines.length !== 1) throw new Error(`nonce history count was ${historyLines.length}`);
await sleep(700);
const settingsScreenshot = path.join(artifactRoot, "settings-live-history.png");
run("screencapture", ["-x", settingsScreenshot]);
const recognized = spawnSync(probe, ["ocr", settingsScreenshot], { encoding: "utf8" });
if (recognized.status !== 0 || !recognized.stdout.includes(native.nonce)) {
  throw new Error(`already-open settings window did not visibly contain nonce ${native.nonce}`);
}

const helperPids = childPids(native.child.pid, "whisper-mac-capture");
if (helperPids.length !== 1) throw new Error(`expected one native helper child, got ${helperPids}`);
process.kill(helperPids[0], "SIGKILL");
await waitForLog(native.logPath, "exited");
const afterKill = await waitForBackend(native, "native-macos");
if (afterKill.captureBackend !== "native-macos") throw new Error("helper failure changed capture backend");
await stopTarget(native);
if (childPids(native.child.pid, "whisper-mac-capture").length !== 0 || spawnSync("pgrep", ["-x", "whisper-mac-capture"]).status === 0) {
  throw new Error("native capture helper leaked after application quit");
}

const baselineAnalysis = analyze(baseline, baseline, path.join(artifactRoot, "baseline-mask.png"));
const electronAnalysis = analyze(baseline, electronControl, path.join(artifactRoot, "electron-control-mask.png"));
const nativeAnalysis = analyze(baseline, nativeTarget, path.join(artifactRoot, "native-target-mask.png"));
if (baselineAnalysis.largeComponentCount !== 0) throw new Error("baseline detector did not equal zero");
if (electronAnalysis.largeComponentCount < 1) throw new Error("Electron positive control did not detect the large orange pill");
if (nativeAnalysis.largeComponentCount !== 0) throw new Error("native target still has the large orange pill");
const inspection = {
  head,
  baseline: baselineAnalysis,
  electronControl: electronAnalysis,
  nativeTarget: nativeAnalysis,
  captureBackend: nativeStatus.captureBackend,
  prebufferAvailableMilliseconds: nativeStatus.prebufferAvailableMilliseconds,
  realPcmReceived: nativeStatus.engineReady && nativeStatus.prebufferAvailableMilliseconds >= 900,
  shortcutToggledRecording: true,
  historyNonce: native.nonce,
  historyNonceCount: historyLines.length,
  helperFailureSurfaced: true,
  helperProcessesAfterQuit: 0,
};
if (inspection.captureBackend !== "native-macos" || inspection.prebufferAvailableMilliseconds < 900 || inspection.prebufferAvailableMilliseconds > 1100) {
  throw new Error(`invalid native status: ${JSON.stringify(inspection)}`);
}
await writeFile(path.join(artifactRoot, "inspection.json"), `${JSON.stringify(inspection, null, 2)}\n`);
for (const name of ["baseline.png", "electron-control.png", "native-target.png", "baseline-mask.png", "electron-control-mask.png", "native-target-mask.png", "inspection.json"]) {
  await access(path.join(artifactRoot, name));
}
console.log(`Live artifacts: ${artifactRoot}`);

function analyze(base, current, mask) {
  const result = spawnSync(probe, ["analyze", base, current, mask], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "menu analysis failed");
  return JSON.parse(result.stdout);
}

async function launchTarget(backend, keep) {
  const root = await mkdtemp(path.join(os.tmpdir(), `whisper-live-${backend}-`));
  const userData = path.join(root, "user-data");
  const modelDir = path.join(root, "models");
  const logs = path.join(root, "logs");
  await Promise.all([userData, modelDir, logs, path.join(root, "captures"), path.join(root, "salvage")].map((directory) => mkdir(directory, { recursive: true })));
  const model = path.join(modelDir, "model.bin");
  await writeFile(model, "fake");
  const port = await freePort();
  const whisperPort = await freePort();
  const nonce = `native${randomUUID().replaceAll("-", "")}`;
  const config = {
    controlHost: "127.0.0.1", controlPort: port, preferredInputDevice: null,
    enforcePreferredInputDevice: false, prebufferMilliseconds: 1000, audioBufferSizeFrames: 128,
    pollIntervalMilliseconds: 150, whisperServerBinary: path.join(appRoot, "tests/e2e/protocol/fake-whisper-server.mjs"),
    whisperCliBinary: path.join(appRoot, "tests/fakes/fake-whisper-cli.mjs"), whisperModelPath: model,
    whisperVADModelPath: null, whisperServerHost: "127.0.0.1", whisperServerPort: whisperPort,
    whisperRobustModelPath: null, robustWhisperServerPort: await freePort(), tempDirectory: path.join(root, "captures"),
    salvageDirectory: path.join(root, "salvage"), daemonLogPath: path.join(logs, "daemon.log"),
    whisperServerLogPath: path.join(logs, "whisper.log"), controlBinaryPath: "unused", daemonBinaryPath: "unused",
    warmServerOnLaunch: true, warmRobustServerOnLaunch: false, whisperThreads: 2,
    persistRecentCaptures: false, persistHistory: true, serverRequestTimeoutSeconds: 5,
    robustServerRequestTimeoutSeconds: 5, cliTimeoutSeconds: 5, launchAtLogin: false,
    macCaptureBackend: backend,
  };
  const configPath = path.join(root, "config.json");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const binary = packagedBinary();
  const logPath = path.join(root, "application.log");
  const fd = openSync(logPath, "a");
  const child = spawn(binary, [`--user-data-dir=${userData}`, "--no-sandbox"], {
    cwd: appRoot,
    env: { ...process.env, WD_CONFIG: configPath, WD_NODE_BINARY: process.execPath, WD_E2E_TRANSCRIPT_NONCE: nonce },
    stdio: ["ignore", fd, fd],
  });
  child.once("exit", () => closeSync(fd));
  return { backend, child, root, userData, port, nonce, logPath, keep };
}

function packagedBinary() {
  const directory = process.arch === "arm64" ? "mac-arm64" : "mac";
  return path.join(appRoot, "release", directory, "Whisper Maxxing.app", "Contents", "MacOS", "Whisper Maxxing");
}

async function waitForReady(target) {
  const deadline = Date.now() + 30000;
  let last;
  while (Date.now() < deadline) {
    if (target.child.exitCode !== null) throw new Error(`application exited; log ${target.logPath}`);
    try {
      const response = await send(target.port, "status");
      last = response.status;
      if (last?.engineReady && last.prebufferAvailableMilliseconds >= 900) return last;
    } catch {}
    await sleep(100);
  }
  throw new Error(`capture did not become ready: ${JSON.stringify(last)}; log ${target.logPath}`);
}

async function waitForRecording(target, expected) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await send(target.port, "status");
    if (response.status?.recording === expected) return response.status;
    await sleep(60);
  }
  throw new Error(`recording did not become ${expected}`);
}

async function waitForStoppedSession(target) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await send(target.port, "status");
    if (!response.status?.recording && response.status?.pendingCount > 0) return target.lastSessionId ?? null;
    await sleep(80);
  }
  throw new Error("shortcut did not stop recording");
}

async function waitForResult(target, sessionId) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const response = await send(target.port, "nextResult", sessionId ?? undefined);
    if (response.resultAvailable && response.result) return response.result;
    await sleep(120);
  }
  throw new Error("transcription result timed out");
}

async function waitForBackend(target, backend) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await send(target.port, "status");
      if (response.status?.captureBackend === backend) return response.status;
    } catch {}
    await sleep(100);
  }
  throw new Error(`backend did not remain ${backend}`);
}

async function stopTarget(target) {
  await send(target.port, "shutdown").catch(() => {});
  const exited = new Promise((resolve) => target.child.once("exit", resolve));
  if (target.child.exitCode === null) {
    const graceful = await Promise.race([exited.then(() => true), sleep(8000).then(() => false)]);
    if (!graceful) { target.child.kill("SIGKILL"); await Promise.race([exited, sleep(2000)]); }
  }
  if (!target.keep) await rm(target.root, { recursive: true, force: true });
}

function send(port, command, sessionId) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let data = "";
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error(`${command} timed out`)); });
    socket.once("connect", () => socket.write(`${JSON.stringify({ command, ...(sessionId ? { sessionId } : {}) })}\n`));
    socket.on("data", (chunk) => { data += chunk; if (data.includes("\n")) { socket.destroy(); resolve(JSON.parse(data.split("\n")[0])); } });
    socket.once("error", reject);
  });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const address = server.address(); const port = address.port; server.close((error) => error ? reject(error) : resolve(port)); });
  });
}

function childPids(parent, name) {
  if (!parent) return [];
  const result = spawnSync("pgrep", ["-P", String(parent), "-x", name], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim().split("\n").filter(Boolean).map(Number) : [];
}

async function waitForFileText(file, text) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { if ((await readFile(file, "utf8")).includes(text)) return; } catch {}
    await sleep(100);
  }
  throw new Error(`history never contained ${text}`);
}

async function waitForLog(file, text) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { if ((await readFile(file, "utf8")).toLowerCase().includes(text.toLowerCase())) return; } catch {}
    await sleep(100);
  }
  throw new Error(`log never contained ${text}`);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
}

function captureMenu(output) {
  const full = `${output}.full.png`;
  run("screencapture", ["-x", full]);
  run(probe, ["crop-menu", full, output]);
  spawnSync("rm", ["-f", full]);
}

function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
