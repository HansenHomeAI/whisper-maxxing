import type { DictationController } from "./dictationController.js";
import { UX_CONTRACT } from "./uxContract.js";

export const HOTKEY_ACCELERATORS = {
  toggleDictation: electronAccelerator(UX_CONTRACT.hotkeys.toggleDictation),
  retryRobust: electronAccelerator(UX_CONTRACT.hotkeys.retryRobust),
  cancelRecording: electronAccelerator(UX_CONTRACT.hotkeys.cancelRecording),
  openHistory: historyHotkeyAccelerator(process.platform),
} as const;

export interface HotkeyRegistrar {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export function registerUxHotkeys(
  controller: DictationController,
  registrar: HotkeyRegistrar,
  openHistory: () => Promise<void>,
  onError: (error: Error) => void = (error) => console.error("hotkey error", error),
): () => void {
  const registrations = [
    [HOTKEY_ACCELERATORS.toggleDictation, () => controller.toggleDictation()],
    [HOTKEY_ACCELERATORS.retryRobust, () => controller.retryRobustTranscription()],
    [HOTKEY_ACCELERATORS.cancelRecording, () => controller.cancelRecording()],
    [HOTKEY_ACCELERATORS.openHistory, openHistory],
  ] as const;
  const registered: string[] = [];

  try {
    for (const [accelerator, action] of registrations) {
      const accepted = registrar.register(accelerator, () => {
        void action().catch((error: unknown) => {
          try {
            onError(error instanceof Error ? error : new Error(String(error)));
          } catch (reportError) {
            console.error("hotkey error reporter failed", reportError);
          }
        });
      });
      if (!accepted) {
        throw new Error(`Unable to register global shortcut ${accelerator}`);
      }
      registered.push(accelerator);
    }
  } catch (error) {
    for (const accelerator of registered) {
      registrar.unregister(accelerator);
    }
    throw error;
  }

  return () => {
    for (const accelerator of registered) {
      registrar.unregister(accelerator);
    }
  };
}

export async function registerSystemUxHotkeys(
  controller: DictationController,
  openHistory: () => Promise<void>,
  onError?: (error: Error) => void,
): Promise<() => void> {
  const { globalShortcut } = await import("electron");
  return registerUxHotkeys(controller, globalShortcut, openHistory, onError);
}

export function historyHotkeyAccelerator(platform: NodeJS.Platform): string {
  return platform === "darwin" ? "Command+Control+H" : "CommandOrControl+Shift+H";
}

function electronAccelerator(contractHotkey: string): string {
  return contractHotkey.replace(/^Command\+/, "CommandOrControl+");
}
