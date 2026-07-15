import type {
  ControlRequest,
  ControlResponse,
  SessionResultPayload,
} from "../../core/controlProtocol.js";
import { HistoryStore } from "./historyStore.js";
import { SettingsWindowController } from "./settingsWindow.js";
import type { SettingsWindowOptions } from "./settingsWindow.js";

export type OpenSettingsHandler = (
  request: ControlRequest,
) => Promise<ControlResponse>;

export interface SettingsHistoryRegistrationOptions
  extends Omit<SettingsWindowOptions, "historyStore"> {
  userDataPath: string;
  persistHistory?: boolean;
  registerControlHandler?: (
    command: "openSettings",
    handler: OpenSettingsHandler,
  ) => (() => void) | void;
  now?: () => Date;
}

export interface SettingsHistoryRegistration {
  historyStore: HistoryStore;
  settingsWindow: SettingsWindowController;
  openSettingsHandler: OpenSettingsHandler;
  recordSuccessfulResult(result: SessionResultPayload): Promise<void>;
  dispose(): void;
}

export function registerSettingsHistory(
  options: SettingsHistoryRegistrationOptions,
): SettingsHistoryRegistration {
  const historyStoreOptions = {
    userDataPath: options.userDataPath,
    ...(options.persistHistory === undefined
      ? {}
      : { persistHistory: options.persistHistory }),
  };
  const historyStore = new HistoryStore(historyStoreOptions);
  const settingsWindowOptions: SettingsWindowOptions = {
    historyStore,
    activeConfig: options.activeConfig,
  };
  if (options.rendererUrl !== undefined) {
    settingsWindowOptions.rendererUrl = options.rendererUrl;
  }
  if (options.preloadPath !== undefined) {
    settingsWindowOptions.preloadPath = options.preloadPath;
  }
  const settingsWindow = new SettingsWindowController(settingsWindowOptions);
  const openSettingsHandler: OpenSettingsHandler = async () => {
    await settingsWindow.open();
    return { ok: true };
  };
  const unregister = options.registerControlHandler?.(
    "openSettings",
    openSettingsHandler,
  );
  const now = options.now ?? (() => new Date());

  return {
    historyStore,
    settingsWindow,
    openSettingsHandler,
    async recordSuccessfulResult(result) {
      if (result.errorMessage != null || result.text.length === 0) {
        return;
      }
      await historyStore.append({
        sessionId: result.sessionId,
        text: result.text,
        profile: result.metrics.transcriptionProfile ?? "fast",
        completedAt: result.metrics.completedAtISO8601 ?? now().toISOString(),
        audioDurationMilliseconds: result.metrics.audioDurationMilliseconds,
        transcriptionMilliseconds: result.metrics.transcriptionMilliseconds ?? 0,
        transcriptionMode: result.metrics.transcriptionMode ?? "unknown",
      });
      settingsWindow.notifyHistoryChanged();
    },
    dispose() {
      unregister?.();
      settingsWindow.dispose();
    },
  };
}
