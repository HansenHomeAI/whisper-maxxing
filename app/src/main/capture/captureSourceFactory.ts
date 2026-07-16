import { join, resolve } from "node:path";

import type { MacCaptureBackend } from "../../core/appConfig.js";
import type { CaptureBackend } from "../../core/controlProtocol.js";
import type { CaptureSource } from "./captureSource.js";
import { NativeMacCaptureSource } from "./nativeMacCaptureSource.js";
import { RendererCaptureSource } from "./rendererCaptureSource.js";

export type { CaptureBackend, MacCaptureBackend };

export interface CreateCaptureSourceOptions {
  platform: NodeJS.Platform;
  macCaptureBackend?: MacCaptureBackend;
  isPackaged: boolean;
  resourcesPath: string;
  appRoot?: string;
}

export interface CreatedCaptureSource {
  source: CaptureSource;
  backend: CaptureBackend;
}

export function selectCaptureBackend(
  platform: NodeJS.Platform,
  macCaptureBackend: MacCaptureBackend = "native",
): CaptureBackend {
  return platform === "darwin" && macCaptureBackend === "native"
    ? "native-macos"
    : "electron-renderer";
}

export function createCaptureSource(
  options: CreateCaptureSourceOptions,
): CreatedCaptureSource {
  const backend = selectCaptureBackend(
    options.platform,
    options.macCaptureBackend,
  );
  if (backend === "electron-renderer") {
    return { source: new RendererCaptureSource(), backend };
  }
  return {
    source: new NativeMacCaptureSource({
      binaryPath: resolveNativeMacCaptureBinary(options),
    }),
    backend,
  };
}

export function resolveNativeMacCaptureBinary(
  options: Pick<
    CreateCaptureSourceOptions,
    "isPackaged" | "resourcesPath" | "appRoot"
  >,
): string {
  if (options.isPackaged) {
    return join(options.resourcesPath, "bin", "whisper-mac-capture");
  }
  return resolve(
    options.appRoot ?? process.cwd(),
    "native",
    "macos-capture",
    ".build",
    "release",
    "whisper-mac-capture",
  );
}
