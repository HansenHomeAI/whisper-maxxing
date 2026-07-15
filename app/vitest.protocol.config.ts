import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    passWithNoTests: false,
    testTimeout: 10_000,
    include: ["tests/e2e/protocol/**/*.spec.ts"],
    exclude: ["**/node_modules/**", "**/dist*/**"],
  },
});
