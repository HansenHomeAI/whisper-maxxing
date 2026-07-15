import { fileURLToPath } from "node:url";

export const CAPTURE_RENDERER_ASSET_FILENAMES = [
  "capture.html",
  "capture-preload.cjs",
  "capture-worklet.js",
] as const;

export function captureRendererPagePath(moduleUrl = import.meta.url): string {
  return fileURLToPath(
    new URL("../../../dist-renderer/capture/capture.html", moduleUrl),
  );
}
