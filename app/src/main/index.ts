import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  app,
  globalShortcut,
  type Tray,
} from "electron";

import {
  parseAppConfig,
  sendJSONSocketRequest,
  type AppConfig,
} from "../core/index.js";
import {
  CaptureEngine,
  RendererCaptureSource,
} from "./capture/index.js";
import { ElectronDaemon } from "./daemon.js";
import {
  registerSettingsHistory,
  type SettingsHistoryRegistration,
} from "./history/index.js";
import { createTray } from "./tray.js";
import {
  DictationController,
  OverlayWindow,
  createSystemPasteEngine,
  createUxSubsystem,
  type UxSubsystem,
} from "./ux/index.js";

interface RunningApplication {
  daemon: ElectronDaemon;
  history: SettingsHistoryRegistration;
  overlay: OverlayWindow;
  tray: Tray | null;
  ux: UxSubsystem | null;
}

let running: RunningApplication | null = null;
let shutdownPromise: Promise<void> | null = null;
let allowExit = false;

if (process.argv.includes("--version")) {
  process.stdout.write(`${app.getVersion()}\n`);
  allowExit = true;
  app.exit(0);
} else {
  void startApplication().catch((error: unknown) => fatal(error));
}

async function startApplication(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    allowExit = true;
    app.quit();
    return;
  }
  app.setName("WhisperDictation");
  await app.whenReady();

  const config = await loadConfig();
  const overlay = new OverlayWindow({ rendererUrl: rendererUrl("overlay") });
  const reportError = (error: Error): void => {
    console.error(error);
    void Promise.resolve()
      .then(() => overlay.showAlert(error.message))
      .catch((alertError: unknown) => console.error(alertError));
  };
  const captureEngine = new CaptureEngine({
    source: new RendererCaptureSource(),
    config,
    onError: reportError,
  });
  const history = registerSettingsHistory({
    userDataPath: app.getPath("userData"),
    persistHistory: config.persistHistory,
    activeConfig: config,
    rendererUrl: rendererUrl("settings"),
  });
  const daemon = new ElectronDaemon({
    config,
    captureEngine,
    openSettings: () =>
      history.openSettingsHandler({ command: "openSettings" }),
    onCompleted: history.recordSuccessfulResult,
    requestQuit: () => app.quit(),
    reportError,
  });

  await daemon.start();
  if (process.env.WD_HEADLESS === "1") {
    running = { daemon, history, overlay, tray: null, ux: null };
    return;
  }
  const controller = new DictationController({
    controlClient: {
      send: (request) =>
        sendJSONSocketRequest(request, config.controlHost, config.controlPort),
    },
    alerts: overlay,
    overlay,
    pasteEngine: await createSystemPasteEngine(),
  });
  const ux = createUxSubsystem({
    controller,
    alerts: overlay,
    hotkeys: globalShortcut,
    logger: console,
  });
  await ux.start();
  const tray = createTray({
    openSettings: () => history.settingsWindow.open(),
    onError: reportError,
  });
  running = { daemon, history, overlay, tray, ux };

  app.on("second-instance", () => {
    void Promise.resolve()
      .then(() => history.settingsWindow.open())
      .catch((error: unknown) => reportError(asError(error)));
  });
}

app.on("before-quit", (event) => {
  if (allowExit) {
    return;
  }
  event.preventDefault();
  if (shutdownPromise === null) {
    shutdownPromise = shutdown().then(
      () => {
        allowExit = true;
        app.exit(0);
      },
      (error: unknown) => {
        console.error(error);
        allowExit = true;
        app.exit(1);
      },
    );
  }
});

// Whisper Maxxing is a tray/daemon application. The hidden capture renderer is
// intentionally recreated during audio recovery, so closing its BrowserWindow
// must not terminate the process when it is temporarily the last window.
app.on("window-all-closed", () => undefined);

async function shutdown(): Promise<void> {
  const current = running;
  running = null;
  if (current === null) {
    return;
  }
  current.ux?.stop();
  current.tray?.destroy();
  current.history.dispose();
  current.overlay.close();
  await current.daemon.dispose();
}

async function loadConfig(): Promise<AppConfig> {
  const configPath =
    process.env.WD_CONFIG?.trim() || defaultConfigPath(process.platform);
  return parseAppConfig(JSON.parse(await readFile(configPath, "utf8")) as unknown);
}

function defaultConfigPath(platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return path.join(
      app.getPath("home"),
      "Library",
      "Application Support",
      "WhisperDictation",
      "config.json",
    );
  }
  return path.join(app.getPath("appData"), "WhisperDictation", "config.json");
}

function rendererUrl(page: "overlay" | "settings"): string {
  if (app.isPackaged) {
    return pathToFileURL(
      path.join(
        process.resourcesPath,
        "app.asar",
        "dist-renderer",
        page,
        "index.html",
      ),
    ).href;
  }
  return pathToFileURL(
    path.join(app.getAppPath(), "dist-renderer", page, "index.html"),
  ).href;
}

function fatal(error: unknown): void {
  console.error(error);
  allowExit = true;
  app.exit(1);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
