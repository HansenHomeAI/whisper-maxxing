import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { app, BrowserWindow, clipboard, ipcMain } from "electron";

import type { HistoryStore } from "./historyStore.js";

export interface SettingsWindowOptions {
  historyStore: HistoryStore;
  activeConfig: Readonly<object>;
  rendererUrl?: string;
  preloadPath?: string;
}

export class SettingsWindowController {
  private window: BrowserWindow | null = null;
  private readonly historyStore: HistoryStore;
  private readonly activeConfig: Readonly<object>;
  private readonly rendererUrl: string;
  private readonly preloadPath: string;

  constructor(options: SettingsWindowOptions) {
    this.historyStore = options.historyStore;
    this.activeConfig = structuredClone(options.activeConfig);
    this.rendererUrl = options.rendererUrl ?? defaultRendererUrl();
    this.preloadPath = options.preloadPath ?? defaultPreloadPath();
    this.registerIpcHandlers();
  }

  async open(): Promise<void> {
    if (this.window !== null && !this.window.isDestroyed()) {
      if (this.window.isMinimized()) {
        this.window.restore();
      }
      this.showAndFocus(this.window);
      this.notifyHistoryChanged();
      return;
    }

    const window = new BrowserWindow({
      width: 600,
      height: 480,
      minWidth: 460,
      minHeight: 400,
      show: false,
      title: "WhisperDictation Settings",
      backgroundColor: "#000000",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: this.preloadPath,
        sandbox: true,
      },
    });
    this.window = window;
    window.once("ready-to-show", () => this.showAndFocus(window));
    window.once("closed", () => {
      if (this.window === window) {
        this.window = null;
      }
    });
    try {
      await window.loadURL(this.rendererUrl);
      if (!window.isDestroyed()) {
        this.showAndFocus(window);
      }
    } catch (error) {
      window.destroy();
      if (this.window === window) {
        this.window = null;
      }
      throw error;
    }
  }

  private showAndFocus(window: BrowserWindow): void {
    if (process.platform === "darwin") {
      app.focus({ steal: true });
    }
    window.show();
    window.focus();
    window.moveTop();
  }

  notifyHistoryChanged(): void {
    const window = this.window;
    if (
      window === null ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      window.webContents.isLoadingMainFrame()
    ) {
      return;
    }
    window.webContents.send("settings:history:reload");
  }

  dispose(): void {
    ipcMain.removeHandler("settings:history:list");
    ipcMain.removeHandler("settings:history:clear");
    ipcMain.removeHandler("settings:clipboard:write");
    ipcMain.removeHandler("settings:config:get");
    this.window?.destroy();
    this.window = null;
  }

  private registerIpcHandlers(): void {
    ipcMain.handle("settings:history:list", () => this.historyStore.read());
    ipcMain.handle("settings:history:clear", () => this.historyStore.clear());
    ipcMain.handle("settings:clipboard:write", (_event, value: unknown) => {
      if (typeof value !== "string") {
        throw new Error("Clipboard text must be a string.");
      }
      clipboard.writeText(value);
    });
    ipcMain.handle("settings:config:get", () => structuredClone(this.activeConfig));
  }
}

function defaultRendererUrl(): string {
  const rendererPath = path.join(
    process.resourcesPath,
    "app.asar",
    "dist-renderer",
    "settings",
    "index.html",
  );
  return pathToFileURL(rendererPath).href;
}

function defaultPreloadPath(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "settingsPreload.cjs",
  );
}
