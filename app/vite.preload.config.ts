import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(
        new URL("./src/main/history/settingsPreload.ts", import.meta.url),
      ),
      formats: ["cjs"],
      fileName: () => "settingsPreload.cjs",
    },
    outDir: fileURLToPath(
      new URL("./dist-electron/main/history", import.meta.url),
    ),
    rollupOptions: {
      external: ["electron"],
    },
  },
});
