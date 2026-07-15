import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { _electron as electron, expect, test } from "@playwright/test";

import { parseMonoPcm16Wav } from "../../fakes/fake-capture-source.js";

const fixturePath = fileURLToPath(
  new URL("../../fixtures/audio/prebuffer-marker.wav", import.meta.url),
);
const harnessPath = fileURLToPath(
  new URL("./capture-harness.cjs", import.meta.url),
);
const capturePagePath = fileURLToPath(
  new URL("../../../src/renderer/capture/capture.html", import.meta.url),
);
const compilerPath = fileURLToPath(
  new URL("../../../node_modules/typescript/bin/tsc", import.meta.url),
);
const compilerConfigPath = fileURLToPath(
  new URL("./tsconfig.json", import.meta.url),
);
const executeFile = promisify(execFile);

test("hidden renderer records non-silent fake microphone audio", async () => {
  const { directory, resultPath, electronApplication } =
    await launchCaptureHarness();
  let applicationClosed = false;
  try {
    const result = await waitForResult(resultPath);
    expect(result.ok, result.error).toBe(true);
    expect(result.wavPath).toBeTruthy();
    expect(result.sampleCount).toBeGreaterThan(10_000);
    expect(result.transferDetached).toBe(true);
    expect(result.allWindowsHidden).toBe(true);

    const wav = parseMonoPcm16Wav(await readFile(result.wavPath!));
    expect(wav.sampleRate).toBe(16_000);
    expect(wav.samples.length).toBe(result.sampleCount);
    expect(rootMeanSquare(wav.samples)).toBeGreaterThan(500);

    await electronApplication.close();
    applicationClosed = true;
    const shutdownResult = await readResult(resultPath);
    expect(shutdownResult.ok, shutdownResult.error).toBe(true);
  } finally {
    try {
      if (!applicationClosed) {
        await electronApplication.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("dispose failures replace success with a failing artifact", async () => {
  const { directory, resultPath, electronApplication } =
    await launchCaptureHarness(true);
  let applicationClosed = false;
  try {
    const result = await waitForResult(resultPath);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("injected capture dispose failure");

    await electronApplication.close();
    applicationClosed = true;
    const shutdownResult = await readResult(resultPath);
    expect(shutdownResult.ok).toBe(false);
    expect(shutdownResult.error).toContain("Capture E2E teardown failed");
  } finally {
    try {
      if (!applicationClosed) {
        await electronApplication.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

async function launchCaptureHarness(injectDisposeFailure = false) {
  const directory = await mkdtemp(join(tmpdir(), "capture-smoke-"));
  const resultPath = join(directory, "result.json");
  const moduleRoot = join(directory, "compiled");
  await executeFile(process.execPath, [
    compilerPath,
    "--project",
    compilerConfigPath,
    "--outDir",
    moduleRoot,
  ]);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const electronApplication = await electron.launch({
    args: [
      harnessPath,
      "--no-sandbox",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${fixturePath}`,
    ],
    env: {
      ...environment,
      CAPTURE_SMOKE_OUTPUT: resultPath,
      CAPTURE_SMOKE_TEMP: directory,
      CAPTURE_SMOKE_MODULE_ROOT: moduleRoot,
      CAPTURE_SMOKE_PAGE: capturePagePath,
      ...(injectDisposeFailure
        ? { CAPTURE_SMOKE_DISPOSE_FAILURE: "1" }
        : {}),
    },
  });
  return { directory, resultPath, electronApplication };
}

async function waitForResult(resultPath: string): Promise<SmokeResult> {
  await expect
    .poll(
      async () => {
        try {
          return await readResult(resultPath);
        } catch {
          return null;
        }
      },
      { timeout: 15_000 },
    )
    .not.toBeNull();
  return await readResult(resultPath);
}

async function readResult(resultPath: string): Promise<SmokeResult> {
  return JSON.parse(await readFile(resultPath, "utf8")) as SmokeResult;
}

interface SmokeResult {
  ok: boolean;
  error?: string;
  wavPath?: string;
  sampleCount?: number;
  transferDetached?: boolean;
  allWindowsHidden?: boolean;
}

function rootMeanSquare(samples: Int16Array): number {
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}
