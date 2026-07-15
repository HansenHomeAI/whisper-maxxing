import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

import { defineConfig, type Plugin } from "vite";

const rendererRoot = fileURLToPath(new URL("./src/renderer", import.meta.url));
const outputRoot = fileURLToPath(new URL("./dist-renderer", import.meta.url));
const candidateInputs = {
  main: path.join(rendererRoot, "index.html"),
  settings: path.join(rendererRoot, "settings", "index.html"),
  capture: path.join(rendererRoot, "capture", "capture.html"),
};
const rendererInputs = Object.fromEntries(
  Object.entries(candidateInputs).filter(([, input]) => existsSync(input)),
);

export default defineConfig({
  base: "./",
  root: rendererRoot,
  plugins: [copyCaptureAssets()],
  build: {
    emptyOutDir: true,
    outDir: outputRoot,
    rollupOptions: {
      input: rendererInputs,
    },
  },
});

function copyCaptureAssets(): Plugin {
  return {
    name: "copy-capture-assets",
    async closeBundle() {
      const captureSource = path.join(rendererRoot, "capture");
      const assets = ["capture-preload.cjs", "capture-worklet.js"];
      if (!assets.every((asset) => existsSync(path.join(captureSource, asset)))) {
        return;
      }
      const destination = path.join(outputRoot, "capture");
      await mkdir(destination, { recursive: true });
      await Promise.all(
        assets.map((asset) =>
          copyFile(path.join(captureSource, asset), path.join(destination, asset)),
        ),
      );
    },
  };
}
