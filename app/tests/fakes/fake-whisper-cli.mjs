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
await writeFile(scenarioPath, `${JSON.stringify(remaining)}\n`, "utf8");

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
