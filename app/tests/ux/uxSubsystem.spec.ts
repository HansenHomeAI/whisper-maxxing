import { describe, expect, it } from "vitest";

import type { DictationController } from "../../src/main/ux/dictationController.js";
import { createUxSubsystem } from "../../src/main/ux/uxSubsystem.js";

describe("UX subsystem detached operations", () => {
  it("reports warmup, restore, and watchdog rejections", async () => {
    const timeoutCallbacks: Array<() => void> = [];
    const intervalCallbacks: Array<() => void> = [];
    const errors: string[] = [];
    const alerts: string[] = [];
    const failure = (name: string) => async () => {
      throw new Error(`${name} rejected`);
    };
    const controller = {
      warmup: failure("warmup"),
      restoreState: failure("restore"),
      watchDaemonStatus: failure("watchdog"),
      toggleDictation: async () => undefined,
      retryRobustTranscription: async () => undefined,
      cancelRecording: async () => undefined,
      stop: () => undefined,
    } as unknown as DictationController;
    const subsystem = createUxSubsystem({
      controller,
      alerts: {
        showAlert(message) {
          alerts.push(message);
        },
      },
      hotkeys: { register: () => true, unregister: () => undefined },
      openHistory: async () => undefined,
      setTimeout(callback) {
        timeoutCallbacks.push(callback);
        return callback;
      },
      clearTimeout: () => undefined,
      scheduler: {
        setInterval(callback) {
          intervalCallbacks.push(callback);
          return callback;
        },
        clearInterval: () => undefined,
      },
      logger: {
        error(message) {
          errors.push(message);
        },
        info: () => undefined,
      },
    });
    await subsystem.start();
    timeoutCallbacks.forEach((callback) => callback());
    intervalCallbacks.forEach((callback) => callback());
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(errors).toEqual([
      "warmup callback error: warmup rejected",
      "restore callback error: restore rejected",
      "watchdog callback error: watchdog rejected",
    ]);
    expect(alerts).toEqual([
      "warmup rejected",
      "restore rejected",
      "watchdog rejected",
    ]);
    subsystem.stop();
  });

  it("keeps the overlay hidden while the idle subsystem starts", async () => {
    const alerts: string[] = [];
    const controller = {
      warmup: async () => undefined,
      restoreState: async () => undefined,
      watchDaemonStatus: async () => undefined,
      toggleDictation: async () => undefined,
      retryRobustTranscription: async () => undefined,
      cancelRecording: async () => undefined,
      stop: () => undefined,
    } as unknown as DictationController;
    const subsystem = createUxSubsystem({
      controller,
      alerts: {
        showAlert(message) {
          alerts.push(message);
        },
      },
      hotkeys: { register: () => true, unregister: () => undefined },
      openHistory: async () => undefined,
      setTimeout: () => ({}),
      clearTimeout: () => undefined,
      scheduler: {
        setInterval: () => ({}),
        clearInterval: () => undefined,
      },
    });

    await subsystem.start();

    expect(alerts).toEqual([]);
    subsystem.stop();
  });
});
