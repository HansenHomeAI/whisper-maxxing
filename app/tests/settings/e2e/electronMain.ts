import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { app } from "electron";

import { JSONSocketServer } from "../../../src/core/jsonSocket.js";
import type { ControlRequest } from "../../../src/core/controlProtocol.js";
import {
  registerSettingsHistory,
  type OpenSettingsHandler,
} from "../../../src/main/history/registration.js";
import { createTray } from "../../../src/main/tray.js";

const configPath = requireEnvironment("WD_E2E_CONFIG");
const rendererUrl = requireEnvironment("WD_E2E_RENDERER_URL");
const preloadPath = requireEnvironment("WD_E2E_PRELOAD_PATH");
const readyPath = requireEnvironment("WD_E2E_READY_PATH");
const errorPath = requireEnvironment("WD_E2E_ERROR_PATH");
const recordedPath = requireEnvironment("WD_E2E_RECORDED_PATH");
const recordTriggerPath = requireEnvironment("WD_E2E_RECORD_TRIGGER_PATH");
const recordedNonce = requireEnvironment("WD_E2E_RECORDED_NONCE");
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
    const handlers = new Map<string, OpenSettingsHandler>();
    const registration = registerSettingsHistory({
      userDataPath,
      activeConfig: config,
      rendererUrl,
      preloadPath,
      persistHistory: config.persistHistory !== false,
      registerControlHandler(command, handler) {
        handlers.set(command, handler);
        return () => handlers.delete(command);
      },
    });
    const tray = createTray({
      openSettings: async () => {
        await requireHandler(handlers, "openSettings")({ command: "openSettings" });
      },
      onError: reportError,
    });
    const server = new JSONSocketServer(
      requireString(config, "controlHost"),
      requireNumber(config, "controlPort"),
      async (request: ControlRequest) => {
        if (request.command === "openSettings") {
          return requireHandler(handlers, "openSettings")(request);
        }
        if (request.command === "status") {
          return { ok: true };
        }
        return { ok: false, error: `Unsupported E2E command: ${request.command}` };
      },
      reportError,
    );
    await server.start();
    await writeFile(readyPath, "ready", "utf8");
    void recordResultAfterTrigger(
      registration,
      recordedNonce,
      recordedPath,
      recordTriggerPath,
    ).catch(reportError);

    app.on("before-quit", () => {
      registration.dispose();
      tray.destroy();
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

  function reportError(error: Error): void {
    void writeFile(errorPath, error.stack ?? error.message);
  }
}

async function recordResultAfterTrigger(
  registration: ReturnType<typeof registerSettingsHistory>,
  text: string,
  markerPath: string,
  triggerPath: string,
): Promise<void> {
  while (true) {
    try {
      await access(triggerPath);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  await recordResult(registration, text, markerPath);
}

function requireHandler(
  handlers: ReadonlyMap<string, OpenSettingsHandler>,
  command: "openSettings",
): OpenSettingsHandler {
  const handler = handlers.get(command);
  if (handler === undefined) {
    throw new Error(`No settings handler registered for ${command}.`);
  }
  return handler;
}

async function recordResult(
  registration: ReturnType<typeof registerSettingsHistory>,
  text: string,
  markerPath: string,
): Promise<void> {
  const sessionId = "recorded-after-open";
  try {
    await registration.recordSuccessfulResult({
      sessionId,
      text,
      metrics: {
        sessionId,
        transcriptionProfile: "robust",
        prebufferMilliseconds: 1_000,
        audioDurationMilliseconds: 3_300,
        transcriptionMilliseconds: 190,
        transcriptionMode: "server",
        completedAtISO8601: new Date().toISOString(),
      },
    });
    await writeFile(markerPath, "recorded", "utf8");
  } catch (error) {
    await writeFile(
      errorPath,
      error instanceof Error ? (error.stack ?? error.message) : String(error),
      "utf8",
    );
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
