import { dirname } from "node:path";
import {
  BrowserWindow,
  MessageChannelMain,
  type MessagePortMain,
} from "electron";

import type {
  CapturedAudioFrame,
  CaptureSource,
  CaptureSourceInfo,
  CaptureSourceStartOptions,
} from "./captureSource.js";
import { captureRendererPagePath } from "./captureRendererAssets.js";

interface RendererCaptureSourceOptions {
  capturePagePath?: string;
}

type RendererMessage =
  | { type: "connected" }
  | { type: "ready"; defaultInputDeviceName: string | null }
  | {
      type: "frame";
      samples: Int16Array | ArrayBuffer;
      timestampMilliseconds: number;
    }
  | { type: "transferStatus"; detached: boolean }
  | { type: "stopped" }
  | { type: "error"; message: string };

export class RendererCaptureSource implements CaptureSource {
  private readonly capturePagePath: string;
  private window: BrowserWindow | null = null;
  private port: MessagePortMain | null = null;
  private stopping = false;
  private stopWaiter: {
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;
  lastFrameTransferDetached: boolean | null = null;

  constructor(options: RendererCaptureSourceOptions = {}) {
    this.capturePagePath =
      options.capturePagePath ??
      captureRendererPagePath();
  }

  async start(
    options: CaptureSourceStartOptions,
  ): Promise<CaptureSourceInfo> {
    await this.stop();
    this.stopping = false;
    this.lastFrameTransferDetached = null;

    const captureWindow = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        preload: `${dirname(this.capturePagePath)}/capture-preload.cjs`,
      },
    });
    this.window = captureWindow;

    return await new Promise<CaptureSourceInfo>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error): void => {
        if (!settled) {
          settled = true;
          reject(error);
        } else {
          options.onError(error);
        }
      };

      captureWindow.once("closed", () => {
        this.window = null;
        this.port?.close();
        this.port = null;
        this.rejectStopWaiter(
          new Error("Audio capture window closed during cleanup."),
        );
        if (!this.stopping) {
          fail(new Error("Audio capture window closed unexpectedly."));
        }
      });
      captureWindow.webContents.once(
        "render-process-gone",
        (_event, details) => {
          fail(
            new Error(
              `Audio capture renderer stopped: ${details.reason}.`,
            ),
          );
        },
      );
      captureWindow.webContents.once("did-fail-load", (_event, code, text) => {
        fail(new Error(`Audio capture window failed to load (${code}): ${text}`));
      });

      void captureWindow.loadFile(this.capturePagePath).then(() => {
        if (captureWindow.isDestroyed()) {
          fail(new Error("Audio capture window closed during startup."));
          return;
        }
        const { port1, port2 } = new MessageChannelMain();
        this.port = port1;
        port1.on("message", (event) => {
          const message = event.data as RendererMessage;
          if (message.type === "connected") {
            port1.postMessage({
              type: "start",
              preferredInputDevice: options.preferredInputDevice,
              enforcePreferredInputDevice:
                options.enforcePreferredInputDevice,
            });
            return;
          }
          if (message.type === "ready") {
            if (!settled) {
              settled = true;
              resolve({
                defaultInputDeviceName: message.defaultInputDeviceName,
              });
            }
            return;
          }
          if (message.type === "error") {
            const error = new Error(message.message);
            if (this.stopWaiter !== null) {
              this.rejectStopWaiter(error);
            } else {
              fail(error);
            }
            return;
          }
          if (message.type === "stopped") {
            this.stopWaiter?.resolve();
            this.stopWaiter = null;
            return;
          }
          if (message.type === "transferStatus") {
            this.lastFrameTransferDetached = message.detached;
            return;
          }
          const samples =
            message.type === "frame"
              ? capturedSamples(message.samples)
              : null;
          if (
            message.type === "frame" &&
            samples !== null &&
            Number.isFinite(message.timestampMilliseconds)
          ) {
            const frame: CapturedAudioFrame = {
              samples,
              timestampMilliseconds: message.timestampMilliseconds,
            };
            options.onFrame(frame);
          }
        });
        port1.start();
        captureWindow.webContents.postMessage("capture:connect", null, [port2]);
      }, fail);
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const errors: Error[] = [];
    const port = this.port;
    if (port !== null) {
      try {
        await this.requestRendererStop(port);
      } catch (error) {
        errors.push(toError(error));
      }
    }
    try {
      this.port?.close();
    } catch (error) {
      errors.push(toError(error));
    }
    this.port = null;
    if (this.window !== null && !this.window.isDestroyed()) {
      try {
        this.window.destroy();
      } catch (error) {
        errors.push(toError(error));
      }
    }
    this.window = null;
    if (errors.length > 0) {
      throw new AggregateError(errors, "Audio capture source cleanup failed.");
    }
  }

  private async requestRendererStop(port: MessagePortMain): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          this.stopWaiter = { resolve, reject };
          port.postMessage({ type: "stop" });
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error("Audio capture renderer cleanup timed out."));
          }, 1_000);
        }),
      ]);
    } finally {
      if (timeout !== null) {
        clearTimeout(timeout);
      }
      this.stopWaiter = null;
    }
  }

  private rejectStopWaiter(error: Error): void {
    this.stopWaiter?.reject(error);
    this.stopWaiter = null;
  }
}

function capturedSamples(value: unknown): Int16Array | null {
  if (value instanceof Int16Array) {
    return value;
  }
  if (ArrayBuffer.isView(value) && value.byteLength % 2 === 0) {
    return new Int16Array(
      value.buffer,
      value.byteOffset,
      value.byteLength / Int16Array.BYTES_PER_ELEMENT,
    );
  }
  if (value instanceof ArrayBuffer && value.byteLength % 2 === 0) {
    return new Int16Array(value);
  }
  return null;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
