import { describe, expect, it } from "vitest";

import {
  HOTKEY_ACCELERATORS,
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
    });
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
        return registered.length < 3;
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
      ),
    ).toThrow("Unable to register global shortcut CommandOrControl+,");
    expect(unregistered).toEqual(["CommandOrControl+.", "CommandOrControl+;"]);
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
