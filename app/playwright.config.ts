import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: [
    "capture/e2e/**/*.spec.ts",
    "ux/e2e/**/*.spec.ts",
    "settings/e2e/**/*.spec.ts",
  ],
  forbidOnly: true,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  ...(process.env.CI ? { workers: 1 } : {}),
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
});
