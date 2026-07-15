import type { BrowserWindow, Rectangle } from "electron";

import {
  overlayDataUrl,
  type OverlayRenderState,
} from "../../renderer/overlay/overlayDocument.js";
import type { AlertSink, OverlaySink, TranscriptionProfile } from "./types.js";
import { UX_CONTRACT, UX_MILLISECONDS } from "./uxContract.js";

const WINDOW_WIDTH = 520;
const WINDOW_HEIGHT = 100;

export interface OverlayWindowOptions {
  onError?: (error: Error) => void;
}

export class OverlayWindow implements AlertSink, OverlaySink {
  private window: BrowserWindow | null = null;
  private readonly onError: (error: Error) => void;
  private recording: OverlayRenderState["recording"] = null;
  private alert: string | null = null;
  private alertGeneration = 0;

  constructor(options: OverlayWindowOptions = {}) {
    this.onError = options.onError ?? ((error) => console.error("overlay error", error));
  }

  async initialize(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) {
      return;
    }
    const { BrowserWindow, screen } = await import("electron");
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const bounds = overlayBounds(display.workArea);
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
    window.setAlwaysOnTop(true, "floating");
    window.setIgnoreMouseEvents(true, { forward: true });
    window.on("closed", () => {
      if (this.window === window) {
        this.window = null;
      }
    });
    await window.loadURL(overlayDataUrl());
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
