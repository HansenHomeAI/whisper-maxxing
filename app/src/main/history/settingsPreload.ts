import { contextBridge, ipcRenderer } from "electron";

import type { HistoryEntry } from "./historyStore.js";

export interface SettingsApi {
  listHistory(): Promise<HistoryEntry[]>;
  clearHistory(): Promise<void>;
  copyText(text: string): Promise<void>;
  getConfig(): Promise<Record<string, unknown>>;
}

const api: SettingsApi = {
  listHistory: () => ipcRenderer.invoke("settings:history:list") as Promise<HistoryEntry[]>,
  clearHistory: () => ipcRenderer.invoke("settings:history:clear") as Promise<void>,
  copyText: (text) => ipcRenderer.invoke("settings:clipboard:write", text) as Promise<void>,
  getConfig: () =>
    ipcRenderer.invoke("settings:config:get") as Promise<Record<string, unknown>>,
};

contextBridge.exposeInMainWorld("settingsApi", api);
