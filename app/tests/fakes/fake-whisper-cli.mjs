#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const scenarioPath = process.env.FAKE_WHISPER_CLI_SCENARIO_FILE;
if (!scenarioPath) {
  process.stderr.write("FAKE_WHISPER_CLI_SCENARIO_FILE is required\n");
  process.exit(2);
}

const decoded = JSON.parse(await readFile(scenarioPath, "utf8"));
const scenarios = Array.isArray(decoded) ? decoded : decoded.scenarios;
if (!Array.isArray(scenarios) || scenarios.length === 0) {
  process.stderr.write("No scripted fake whisper CLI scenario remains\n");
  process.exit(2);
}
const [scenario, ...remaining] = scenarios;

const argument = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const modelPath = argument("-m");
const wavPath = argument("-f");
const expectedModel = scenario.expectedModel ?? process.env.FAKE_WHISPER_CLI_EXPECTED_MODEL;
if (!modelPath || !wavPath || !process.argv.includes("-nt") || !process.argv.includes("-np")) {
  process.stderr.write("Expected whisper-cli -m/-f/-nt/-np arguments\n");
  process.exit(3);
}
if (!expectedModel || modelPath !== expectedModel) {
  process.stderr.write(`Unexpected model: ${modelPath}; expected: ${expectedModel ?? "(unset)"}\n`);
  process.exit(3);
}
let wav;
try {
  wav = await readFile(wavPath);
} catch (error) {
  process.stderr.write(`Unable to open WAV input: ${error.message}\n`);
  process.exit(3);
}
if (
  wav.length < 44 ||
  wav.subarray(0, 4).toString("ascii") !== "RIFF" ||
  wav.subarray(8, 12).toString("ascii") !== "WAVE" ||
  wav.readUInt32LE(4) !== wav.length - 8
) {
  process.stderr.write("Input is not a complete RIFF/WAVE file\n");
  process.exit(3);
}

await writeFile(scenarioPath, `${JSON.stringify(remaining)}\n`, "utf8");
if (process.env.FAKE_WHISPER_CLI_PID_FILE) {
  await writeFile(process.env.FAKE_WHISPER_CLI_PID_FILE, `${process.pid}\n`, "utf8");
}

if (scenario.kind === "delay") {
  await new Promise((resolve) => setTimeout(resolve, scenario.milliseconds));
  process.stdout.write(`${scenario.text ?? ""}\n`);
  process.exit(0);
}
if (scenario.kind === "hang") {
  await new Promise(() => setInterval(() => {}, 60_000));
}
if (scenario.kind === "error") {
  process.stderr.write(`${scenario.message ?? "scripted CLI error"}\n`);
  process.exit(Number.isInteger(scenario.exitCode) ? scenario.exitCode : 1);
}
if (scenario.kind === "no-speech") {
  process.stdout.write("[BLANK_AUDIO]\n");
  process.exit(0);
}
if (scenario.kind !== "transcript") {
  process.stderr.write(`Unknown fake whisper CLI scenario: ${scenario.kind}\n`);
  process.exit(2);
}
process.stdout.write(`${scenario.text}\n`);
