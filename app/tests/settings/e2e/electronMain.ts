import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { app } from "electron";

import { JSONSocketServer } from "../../../src/core/jsonSocket.js";
import type { ControlRequest } from "../../../src/core/controlProtocol.js";
import { HistoryStore } from "../../../src/main/history/historyStore.js";
import { SettingsWindowController } from "../../../src/main/history/settingsWindow.js";

const configPath = requireEnvironment("WD_E2E_CONFIG");
const rendererUrl = requireEnvironment("WD_E2E_RENDERER_URL");
const preloadPath = requireEnvironment("WD_E2E_PRELOAD_PATH");
const readyPath = requireEnvironment("WD_E2E_READY_PATH");
const errorPath = requireEnvironment("WD_E2E_ERROR_PATH");
const userDataPath = path.dirname(configPath);

app.setPath("userData", userDataPath);
void start();

async function start(): Promise<void> {
  try {
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    await app.whenReady();
    const historyStore = new HistoryStore({ userDataPath });
    const settingsWindow = new SettingsWindowController({
      historyStore,
      activeConfig: config,
      rendererUrl,
      preloadPath,
    });
    const server = new JSONSocketServer(
      requireString(config, "controlHost"),
      requireNumber(config, "controlPort"),
      async (request: ControlRequest) => {
        if (request.command === "openSettings") {
          await settingsWindow.open();
          return { ok: true };
        }
        if (request.command === "status") {
          return { ok: true };
        }
        return { ok: false, error: `Unsupported E2E command: ${request.command}` };
      },
      (error) => {
        void writeFile(errorPath, error.stack ?? error.message);
      },
    );
    await server.start();
    await writeFile(readyPath, "ready", "utf8");

    app.on("before-quit", () => {
      settingsWindow.dispose();
      void server.stop();
    });
  } catch (error) {
    await writeFile(
      errorPath,
      error instanceof Error ? (error.stack ?? error.message) : String(error),
      "utf8",
    );
    app.exit(1);
  }
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function requireString(source: Record<string, unknown>, name: string): string {
  const value = source[name];
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string.`);
  }
  return value;
}

function requireNumber(source: Record<string, unknown>, name: string): number {
  const value = source[name];
  if (typeof value !== "number") {
    throw new Error(`${name} must be a number.`);
  }
  return value;
}
