import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./src/renderer", import.meta.url)),
  build: {
    emptyOutDir: true,
    outDir: fileURLToPath(new URL("./dist-renderer", import.meta.url)),
  },
});
