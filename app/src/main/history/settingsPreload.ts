import { contextBridge, ipcRenderer } from "electron";

import type { HistoryEntry } from "./historyStore.js";

export interface SettingsApi {
  listHistory(): Promise<HistoryEntry[]>;
  clearHistory(): Promise<void>;
  copyText(text: string): Promise<void>;
  getConfig(): Promise<Record<string, unknown>>;
  onHistoryReload(callback: () => void): () => void;
}

const api: SettingsApi = {
  listHistory: () => ipcRenderer.invoke("settings:history:list") as Promise<HistoryEntry[]>,
  clearHistory: () => ipcRenderer.invoke("settings:history:clear") as Promise<void>,
  copyText: (text) => ipcRenderer.invoke("settings:clipboard:write", text) as Promise<void>,
  getConfig: () =>
    ipcRenderer.invoke("settings:config:get") as Promise<Record<string, unknown>>,
  onHistoryReload: (callback) => {
    const listener = (): void => callback();
    ipcRenderer.on("settings:history:reload", listener);
    return () => ipcRenderer.removeListener("settings:history:reload", listener);
  },
};

contextBridge.exposeInMainWorld("settingsApi", api);
