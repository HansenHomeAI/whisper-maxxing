import type { SettingsApi } from "../../main/history/settingsPreload.js";

declare global {
  interface Window {
    settingsApi: SettingsApi;
  }
}

export {};
