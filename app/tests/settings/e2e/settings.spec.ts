import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { _electron as electron, expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { build } from "vite";

import type { HistoryEntry } from "../../../src/main/history/historyStore.js";

const executeFile = promisify(execFile);
const appRoot = path.resolve(import.meta.dirname, "../../..");
const wdctlPath = path.join(appRoot, "bin", "wdctl.mjs");
const sourceRoot = path.join(appRoot, "src");

let electronApplication: ElectronApplication | null = null;
let temporaryDirectory = "";

test.afterEach(async () => {
  await electronApplication?.close();
  electronApplication = null;
  if (temporaryDirectory !== "") {
    await rm(temporaryDirectory, { force: true, recursive: true });
    temporaryDirectory = "";
  }
});

test("opens real seeded history through wdctl and clears the JSONL file", async () => {
  test.setTimeout(60_000);
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "wd-settings-e2e-"));
  const artifacts = await buildApplication(temporaryDirectory);
  await assertPackagedRendererAssets(artifacts.rendererPath);
  const controlPort = await findAvailablePort();
  const configPath = path.join(temporaryDirectory, "config.json");
  const historyPath = path.join(temporaryDirectory, "history.jsonl");
  const readyPath = path.join(temporaryDirectory, "ready");
  const errorPath = path.join(temporaryDirectory, "error.log");
  const recordedPath = path.join(temporaryDirectory, "recorded");
  const firstNonce = `alpha-${randomUUID()}`;
  const secondNonce = `bravo-${randomUUID()}`;
  const recordedNonce = `recorded-${randomUUID()}`;
  const older = historyEntry("older", firstNonce, "2026-07-14T14:00:00.000Z");
  const newer = historyEntry("newer", secondNonce, "2026-07-14T14:01:00.000Z");

  await writeFile(
    historyPath,
    `${JSON.stringify(older)}\ncorrupt-line\n${JSON.stringify(newer)}\n`,
    "utf8",
  );
  await writeFile(
    configPath,
    JSON.stringify({
      controlHost: "127.0.0.1",
      controlPort,
      persistHistory: true,
      daemonBinaryPath: process.execPath,
      preferredInputDevice: "E2E microphone",
    }),
    "utf8",
  );

  electronApplication = await electron.launch({
    args: [artifacts.mainPath],
    env: {
      ...process.env,
      WD_E2E_CONFIG: configPath,
      WD_E2E_RENDERER_URL: pathToFileURL(artifacts.rendererPath).href,
      WD_E2E_PRELOAD_PATH: artifacts.preloadPath,
      WD_E2E_READY_PATH: readyPath,
      WD_E2E_ERROR_PATH: errorPath,
      WD_E2E_RECORDED_PATH: recordedPath,
      WD_E2E_RECORDED_NONCE: recordedNonce,
    },
  });
  await waitForReady(readyPath, errorPath);

  const cli = await executeFile(process.execPath, [wdctlPath, "open-settings"], {
    env: { ...process.env, WDCTL_CONFIG: configPath },
  });
  const response = JSON.parse(cli.stdout) as Record<string, unknown>;
  expect(response.ok).toBe(true);
  expect(response.clientObservedMilliseconds).toEqual(expect.any(Number));

  const page = await settingsPage(electronApplication);
  const renderedEntries = page.locator(".history-entry .entry-text");
  await expect
    .poll(async () => (await renderedEntries.allTextContents()).slice(-2))
    .toEqual([secondNonce, firstNonce]);
  await page.getByText("Active configuration").click();
  await expect(page.getByText("E2E microphone", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Copy newer" }).click();
  await expect
    .poll(() =>
      electronApplication?.evaluate(({ clipboard }) => clipboard.readText()),
    )
    .toBe(secondNonce);

  await waitForReady(recordedPath, errorPath, "recorded");
  await expect(readFile(historyPath, "utf8")).resolves.toContain(recordedNonce);
  await expect(renderedEntries).toHaveText([
    recordedNonce,
    secondNonce,
    firstNonce,
  ]);
  await executeFile(process.execPath, [wdctlPath, "open-settings"], {
    env: { ...process.env, WDCTL_CONFIG: configPath },
  });
  expect(electronApplication.windows()).toHaveLength(1);
  await expect(renderedEntries).toHaveText([
    recordedNonce,
    secondNonce,
    firstNonce,
  ]);

  await page.getByPlaceholder("Search history").fill(firstNonce.slice(0, 14));
  await expect(renderedEntries).toHaveText([firstNonce]);
  await expect(page.getByText(secondNonce)).toHaveCount(0);

  await page.getByPlaceholder("Search history").fill("");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Clear History" }).click();
  await expect(page.locator(".history-entry")).toHaveCount(3);
  await expect(readFile(historyPath, "utf8")).resolves.toContain(firstNonce);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Clear History" }).click();

  await expect(page.locator(".history-entry")).toHaveCount(0);
  await expect(page.getByText("No transcription history yet.")).toBeVisible();
  await expect.poll(() => readFile(historyPath, "utf8")).toBe("");
});

async function buildApplication(outputRoot: string): Promise<{
  mainPath: string;
  preloadPath: string;
  rendererPath: string;
}> {
  const mainOutput = path.join(outputRoot, "main");
  const preloadOutput = path.join(outputRoot, "preload");

  await build({
    configFile: false,
    logLevel: "silent",
    build: {
      emptyOutDir: true,
      minify: false,
      outDir: mainOutput,
      rollupOptions: {
        external: ["electron", /^node:/],
        input: path.join(import.meta.dirname, "electronMain.ts"),
        output: { entryFileNames: "electronMain.mjs", format: "es" },
      },
      ssr: true,
      target: "node22",
    },
  });
  await build({
    configFile: false,
    logLevel: "silent",
    build: {
      emptyOutDir: true,
      minify: false,
      outDir: preloadOutput,
      rollupOptions: {
        external: ["electron"],
        input: path.join(sourceRoot, "main", "history", "settingsPreload.ts"),
        output: { entryFileNames: "settingsPreload.cjs", format: "cjs" },
      },
      ssr: true,
      target: "node22",
    },
  });
  await build({
    configFile: path.join(appRoot, "vite.config.ts"),
    logLevel: "silent",
  });

  return {
    mainPath: path.join(mainOutput, "electronMain.mjs"),
    preloadPath: path.join(preloadOutput, "settingsPreload.cjs"),
    rendererPath: path.join(appRoot, "dist-renderer", "settings", "index.html"),
  };
}

async function assertPackagedRendererAssets(rendererPath: string): Promise<void> {
  const html = await readFile(rendererPath, "utf8");
  const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((reference): reference is string =>
      reference !== undefined && !reference.startsWith("data:"),
    );
  expect(references.length).toBeGreaterThan(0);
  for (const reference of references) {
    expect(reference.startsWith("/")).toBe(false);
    const referencedPath = path.resolve(path.dirname(rendererPath), reference);
    await expect(access(referencedPath)).resolves.toBeUndefined();
  }
}

async function settingsPage(application: ElectronApplication): Promise<Page> {
  await expect.poll(() => application.windows().length).toBe(1);
  const page = application.windows()[0];
  if (page === undefined) {
    throw new Error("Settings window did not open.");
  }
  await page.waitForLoadState("domcontentloaded");
  return page;
}

async function waitForReady(
  readyPath: string,
  errorPath: string,
  expected = "ready",
): Promise<void> {
  await expect
    .poll(async () => {
      try {
        return await readFile(readyPath, "utf8");
      } catch {
        try {
          throw new Error(await readFile(errorPath, "utf8"));
        } catch (error) {
          if (error instanceof Error && !error.message.includes("ENOENT")) {
            throw error;
          }
          return "";
        }
      }
    })
    .toBe(expected);
}

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a control port."));
        return;
      }
      const { port } = address;
      server.close((error) => (error === undefined ? resolve(port) : reject(error)));
    });
  });
}

function historyEntry(
  sessionId: string,
  text: string,
  completedAt: string,
): HistoryEntry {
  return {
    sessionId,
    text,
    profile: sessionId === "newer" ? "robust" : "fast",
    completedAt,
    audioDurationMilliseconds: 2_500,
    transcriptionMilliseconds: 175,
    transcriptionMode: "server",
  };
}
