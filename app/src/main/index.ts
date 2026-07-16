import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  app,
  globalShortcut,
  shell,
  type Tray,
} from "electron";

import {
  sendJSONSocketRequest,
} from "../core/index.js";
import {
  CaptureEngine,
  createCaptureSource,
} from "./capture/index.js";
import { ElectronDaemon } from "./daemon.js";
import {
  ensureFirstRunConfig,
  openMacPermissionSettings,
} from "./firstRun.js";
import {
  registerSettingsHistory,
  type SettingsHistoryRegistration,
} from "./history/index.js";
import { createTray } from "./tray.js";
import { configureLaunchAtLogin } from "./loginItem.js";
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

  const explicitConfigPath = process.env.WD_CONFIG?.trim();
  const firstRun = await ensureFirstRunConfig(
    explicitConfigPath ? { configPath: explicitConfigPath } : {},
  );
  const config = firstRun.config;
  if (process.env.WD_HEADLESS !== "1") {
    configureLaunchAtLogin(app, config);
  }
  if (firstRun.created && process.platform === "darwin") {
    await guideMacPermissions();
  }
  const overlay = new OverlayWindow({ rendererUrl: rendererUrl("overlay") });
  const reportError = (error: Error): void => {
    console.error(error);
    void Promise.resolve()
      .then(() => overlay.showAlert(error.message))
      .catch((alertError: unknown) => console.error(alertError));
  };
  const captureSource = createCaptureSource({
    platform: process.platform,
    macCaptureBackend: config.macCaptureBackend ?? "native",
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appRoot: app.getAppPath(),
  });
  const captureEngine = new CaptureEngine({
    source: captureSource.source,
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
    captureBackend: captureSource.backend,
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
    openHistory: () => history.settingsWindow.open(),
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

async function guideMacPermissions(): Promise<void> {
  const openExternal = (url: string): Promise<void> => shell.openExternal(url);
  await openMacPermissionSettings("microphone", openExternal);
  await openMacPermissionSettings("accessibility", openExternal);
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
