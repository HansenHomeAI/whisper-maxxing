import path from "node:path";
import { pathToFileURL } from "node:url";

import type { BrowserWindow, Rectangle } from "electron";

import type { OverlayRenderState } from "../../renderer/overlay/types.js";
import type { AlertSink, OverlaySink, TranscriptionProfile } from "./types.js";
import { UX_CONTRACT, UX_MILLISECONDS } from "./uxContract.js";

const WINDOW_WIDTH = 520;
const WINDOW_HEIGHT = 100;

export interface OverlayWindowOptions {
  onError?: (error: Error) => void;
  rendererUrl?: string;
}

export class OverlayWindow implements AlertSink, OverlaySink {
  private window: BrowserWindow | null = null;
  private readonly onError: (error: Error) => void;
  private readonly rendererUrl: string;
  private recording: OverlayRenderState["recording"] = null;
  private alert: string | null = null;
  private alertGeneration = 0;

  constructor(options: OverlayWindowOptions = {}) {
    this.onError = options.onError ?? ((error) => console.error("overlay error", error));
    this.rendererUrl = options.rendererUrl ?? defaultRendererUrl();
  }

  async initialize(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) {
      return;
    }
    const { BrowserWindow, screen } = await import("electron");
    const bounds = overlayBounds(primaryDisplayWorkArea(screen));
    const window = new BrowserWindow({
      ...bounds,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      show: false,
      alwaysOnTop: true,
      hasShadow: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.setAlwaysOnTop(true, "screen-saver");
    if (process.platform === "darwin") {
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    window.setIgnoreMouseEvents(true, { forward: true });
    window.on("closed", () => {
      if (this.window === window) {
        this.window = null;
      }
    });
    await window.loadURL(this.rendererUrl);
    this.window = window;
    await this.render();
  }

  async showRecording(profile: TranscriptionProfile): Promise<void> {
    this.recording = {
      profile,
      label:
        profile === "robust"
          ? UX_CONTRACT.alerts.recordingRobust
          : UX_CONTRACT.alerts.recording,
    };
    await this.render();
  }

  async hideRecording(): Promise<void> {
    this.recording = null;
    await this.render();
  }

  async showAlert(message: string): Promise<void> {
    const generation = ++this.alertGeneration;
    this.alert = message;
    await this.render();
    setTimeout(() => {
      if (this.alertGeneration !== generation) {
        return;
      }
      this.alert = null;
      void this.render().catch((error: unknown) => this.report(error));
    }, UX_MILLISECONDS.alertDuration);
  }

  close(): void {
    this.alertGeneration += 1;
    this.window?.destroy();
    this.window = null;
  }

  private async render(): Promise<void> {
    await this.initialize();
    const window = this.window;
    if (!window || window.isDestroyed()) {
      throw new Error("Overlay window is unavailable");
    }
    const state: OverlayRenderState = { recording: this.recording, alert: this.alert };
    await window.webContents.executeJavaScript(
      `window.whisperOverlay.render(${JSON.stringify(state)})`,
      true,
    );
    if (this.recording || this.alert) {
      window.showInactive();
    } else {
      window.hide();
    }
  }

  private report(error: unknown): void {
    this.onError(error instanceof Error ? error : new Error(String(error)));
  }
}

export function overlayBounds(workArea: Rectangle): Rectangle {
  return {
    x: Math.round(workArea.x + (workArea.width - WINDOW_WIDTH) / 2),
    y: Math.round(
      workArea.y + workArea.height - WINDOW_HEIGHT - UX_CONTRACT.overlay.bottomMarginPx,
    ),
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
  };
}

export interface PrimaryDisplaySource {
  getPrimaryDisplay(): { workArea: Rectangle };
}

export function primaryDisplayWorkArea(source: PrimaryDisplaySource): Rectangle {
  return source.getPrimaryDisplay().workArea;
}

function defaultRendererUrl(): string {
  return pathToFileURL(
    path.join(
      process.resourcesPath,
      "app.asar",
      "dist-renderer",
      "overlay",
      "index.html",
    ),
  ).href;
}
