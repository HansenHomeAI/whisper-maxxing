import { describe, expect, it } from "vitest";

import {
  PasteEngine,
  type ClipboardWriter,
  type CommandExecutor,
} from "../../src/main/ux/pasteEngine.js";
import type { ReplacementTarget } from "../../src/main/ux/types.js";

function target(appIdentity = "com.example.Editor"): ReplacementTarget {
  return {
    originalSessionId: "original",
    originalProfile: "fast",
    pastedAtSeconds: 10,
    appIdentity,
    requestedAtSeconds: 11,
  };
}

describe("PasteEngine", () => {
  it("sets the clipboard before the macOS paste keystroke", async () => {
    const events: string[] = [];
    const engine = makeMacEngine(events, "com.example.Editor");
    await engine.paste("hello");
    expect(events).toEqual([
      "clipboard:hello",
      'exec:/usr/bin/osascript:-e|tell application "System Events" to keystroke "v" using command down',
    ]);
  });

  it("undoes, waits, then sets clipboard and pastes for the same app", async () => {
    const events: string[] = [];
    const engine = makeMacEngine(events, "com.example.Editor");
    await engine.paste("replacement", target());
    expect(events).toEqual([
      "frontmost",
      'exec:/usr/bin/osascript:-e|tell application "System Events" to keystroke "z" using command down',
      "sleep:80",
      "clipboard:replacement",
      'exec:/usr/bin/osascript:-e|tell application "System Events" to keystroke "v" using command down',
    ]);
  });

  it("pastes normally when the frontmost app changed", async () => {
    const events: string[] = [];
    const engine = makeMacEngine(events, "com.example.Other");
    await engine.paste("replacement", target());
    expect(events).toEqual([
      "frontmost",
      "clipboard:replacement",
      'exec:/usr/bin/osascript:-e|tell application "System Events" to keystroke "v" using command down',
    ]);
  });

  it("uses the bundled Windows helper for identity, undo, and paste", async () => {
    const events: string[] = [];
    const executor: CommandExecutor = {
      async run(file, args) {
        const action = args.at(-1);
        events.push(`${file}:${action}`);
        return { stdout: action === "foreground" ? "Editor\r\n" : "", stderr: "" };
      },
    };
    const engine = new PasteEngine({
      platform: "win32",
      clipboard: { writeText: (text) => events.push(`clipboard:${text}`) },
      executor,
      windowsHelperPath: "C:\\Whisper\\send-input.ps1",
      sleep: async (milliseconds) => {
        events.push(`sleep:${milliseconds}`);
      },
    });
    await engine.paste("replacement", target("Editor"));
    expect(events).toEqual([
      "powershell.exe:foreground",
      "powershell.exe:undo",
      "sleep:80",
      "clipboard:replacement",
      "powershell.exe:paste",
    ]);
  });

  it("surfaces executor failures", async () => {
    const engine = new PasteEngine({
      platform: "darwin",
      clipboard: { writeText: () => undefined },
      executor: {
        async run() {
          throw new Error("Accessibility permission denied");
        },
      },
    });
    await expect(engine.paste("hello")).rejects.toThrow("Accessibility permission denied");
  });
});

function makeMacEngine(events: string[], appIdentity: string): PasteEngine {
  const clipboard: ClipboardWriter = {
    writeText(text) {
      events.push(`clipboard:${text}`);
    },
  };
  const executor: CommandExecutor = {
    async run(file, args) {
      if (args[1]?.includes("bundle identifier")) {
        events.push("frontmost");
        return { stdout: `${appIdentity}\n`, stderr: "" };
      }
      events.push(`exec:${file}:${args.join("|")}`);
      return { stdout: "", stderr: "" };
    },
  };
  return new PasteEngine({
    platform: "darwin",
    clipboard,
    executor,
    sleep: async (milliseconds) => {
      events.push(`sleep:${milliseconds}`);
    },
  });
}
