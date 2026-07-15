import { describe, expect, it } from "vitest";

import {
  HOTKEY_ACCELERATORS,
  historyHotkeyAccelerator,
  registerUxHotkeys,
  type HotkeyRegistrar,
} from "../../src/main/ux/hotkeys.js";
import {
  overlayBounds,
  primaryDisplayWorkArea,
} from "../../src/main/ux/overlayWindow.js";
import { UX_CONTRACT } from "../../src/main/ux/uxContract.js";

describe("UX hotkeys", () => {
  it("registers Command on macOS and Control on Windows through Electron accelerators", () => {
    expect(HOTKEY_ACCELERATORS).toEqual({
      toggleDictation: "CommandOrControl+.",
      retryRobust: "CommandOrControl+;",
      cancelRecording: "CommandOrControl+,",
      openHistory:
        process.platform === "darwin"
          ? "Command+Control+H"
          : "CommandOrControl+Shift+H",
    });
    expect(historyHotkeyAccelerator("darwin")).toBe("Command+Control+H");
    expect(historyHotkeyAccelerator("win32")).toBe("CommandOrControl+Shift+H");
    expect(UX_CONTRACT.hotkeys).toEqual({
      toggleDictation: "Command+.",
      retryRobust: "Command+;",
      cancelRecording: "Command+,",
    });
  });

  it("unregisters successful shortcuts if a later registration fails", () => {
    const registered: string[] = [];
    const unregistered: string[] = [];
    const registrar: HotkeyRegistrar = {
      register(accelerator) {
        registered.push(accelerator);
        return registered.length < 4;
      },
      unregister(accelerator) {
        unregistered.push(accelerator);
      },
    };
    const controller = {
      toggleDictation: async () => undefined,
      retryRobustTranscription: async () => undefined,
      cancelRecording: async () => undefined,
    };
    expect(() =>
      registerUxHotkeys(
        controller as Parameters<typeof registerUxHotkeys>[0],
        registrar,
        async () => undefined,
      ),
    ).toThrow(`Unable to register global shortcut ${HOTKEY_ACCELERATORS.openHistory}`);
    expect(unregistered).toEqual([
      "CommandOrControl+.",
      "CommandOrControl+;",
      "CommandOrControl+,",
    ]);
  });

  it("opens history through the dedicated global shortcut", async () => {
    const callbacks = new Map<string, () => void>();
    let historyOpenCount = 0;
    const registrar: HotkeyRegistrar = {
      register(accelerator, callback) {
        callbacks.set(accelerator, callback);
        return true;
      },
      unregister: () => undefined,
    };
    const controller = {
      toggleDictation: async () => undefined,
      retryRobustTranscription: async () => undefined,
      cancelRecording: async () => undefined,
    };
    registerUxHotkeys(
      controller as Parameters<typeof registerUxHotkeys>[0],
      registrar,
      async () => {
        historyOpenCount += 1;
      },
    );

    callbacks.get(HOTKEY_ACCELERATORS.openHistory)?.();
    await new Promise((resolve) => setImmediate(resolve));

    expect(historyOpenCount).toBe(1);
  });
});

describe("overlay geometry", () => {
  it("positions the click-through window bottom-center with the fixture margin", () => {
    expect(overlayBounds({ x: 10, y: 20, width: 1_200, height: 800 })).toEqual({
      x: 350,
      y: 700,
      width: 520,
      height: 100,
    });
  });

  it("uses the primary display like Hammerspoon mainScreen", () => {
    let primaryCalls = 0;
    const workArea = { x: 0, y: 0, width: 1_920, height: 1_080 };
    expect(
      primaryDisplayWorkArea({
        getPrimaryDisplay() {
          primaryCalls += 1;
          return { workArea };
        },
      }),
    ).toBe(workArea);
    expect(primaryCalls).toBe(1);
  });
});
