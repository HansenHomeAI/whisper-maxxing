import type { DictationController } from "./dictationController.js";
import { registerUxHotkeys, type HotkeyRegistrar } from "./hotkeys.js";
import type { AlertSink, Logger, Scheduler } from "./types.js";
import { UX_CONTRACT, UX_MILLISECONDS } from "./uxContract.js";

export interface UxSubsystemOptions {
  controller: DictationController;
  alerts: AlertSink;
  hotkeys: HotkeyRegistrar;
  openHistory(): Promise<void>;
  scheduler?: Pick<Scheduler, "setInterval" | "clearInterval">;
  logger?: Logger;
  setTimeout?: (callback: () => void, milliseconds: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface UxSubsystem {
  start(): Promise<void>;
  stop(): void;
}

export function createUxSubsystem(options: UxSubsystemOptions): UxSubsystem {
  const intervalScheduler = options.scheduler ?? {
    setInterval: (callback: () => void, milliseconds: number) => setInterval(callback, milliseconds),
    clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
  const schedule =
    options.setTimeout ??
    ((callback: () => void, milliseconds: number): unknown => setTimeout(callback, milliseconds));
  const unschedule =
    options.clearTimeout ??
    ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const logger = options.logger ?? console;
  let unregisterHotkeys: (() => void) | null = null;
  let watchdog: unknown | null = null;
  const startupTimers: unknown[] = [];

  const surface = (label: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`${label}: ${message}`);
    void Promise.resolve()
      .then(() => options.alerts.showAlert(message))
      .catch((alertError: unknown) => {
        logger.error(`alert error: ${String(alertError)}`);
      });
  };
  const runDetached = (label: string, operation: () => Promise<void>): void => {
    void Promise.resolve()
      .then(operation)
      .catch((error: unknown) => surface(label, error));
  };

  return {
    async start() {
      unregisterHotkeys = registerUxHotkeys(
        options.controller,
        options.hotkeys,
        options.openHistory,
        (error) => surface("hotkey error", error),
      );
      startupTimers.push(
        schedule(() => {
          runDetached("warmup callback error", () => options.controller.warmup());
        }, UX_MILLISECONDS.warmupDelay),
        schedule(() => {
          runDetached("restore callback error", () => options.controller.restoreState());
        }, UX_MILLISECONDS.restoreStateDelay),
      );
      watchdog = intervalScheduler.setInterval(() => {
        runDetached("watchdog callback error", () => options.controller.watchDaemonStatus());
      }, UX_MILLISECONDS.statusWatchdogInterval);
      await options.alerts.showAlert(UX_CONTRACT.alerts.ready);
    },
    stop() {
      unregisterHotkeys?.();
      unregisterHotkeys = null;
      if (watchdog !== null) {
        intervalScheduler.clearInterval(watchdog);
        watchdog = null;
      }
      for (const timer of startupTimers.splice(0)) {
        unschedule(timer);
      }
      options.controller.stop();
    },
  };
}
