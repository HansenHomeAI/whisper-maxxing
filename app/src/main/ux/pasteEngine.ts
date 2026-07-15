import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { PasteEnginePort, ReplacementTarget } from "./types.js";
import { UX_MILLISECONDS } from "./uxContract.js";

const execFileAsync = promisify(execFile);
const SYSTEM_EVENTS_SCRIPT = (key: "v" | "z") =>
  `tell application "System Events" to keystroke "${key}" using command down`;

export interface ClipboardWriter {
  writeText(text: string): void;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandExecutor {
  run(executable: string, args: readonly string[]): Promise<CommandResult>;
}

export interface PasteEngineOptions {
  platform: NodeJS.Platform;
  clipboard: ClipboardWriter;
  executor: CommandExecutor;
  sleep?: (milliseconds: number) => Promise<void>;
  windowsHelperPath?: string;
}

export class PasteEngine implements PasteEnginePort {
  private readonly platform: NodeJS.Platform;
  private readonly clipboard: ClipboardWriter;
  private readonly executor: CommandExecutor;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly windowsHelperPath: string;

  constructor(options: PasteEngineOptions) {
    this.platform = options.platform;
    this.clipboard = options.clipboard;
    this.executor = options.executor;
    this.sleep = options.sleep ?? ((milliseconds) => delay(milliseconds));
    this.windowsHelperPath =
      options.windowsHelperPath ??
      path.join(process.resourcesPath ?? path.resolve("resources"), "win", "send-input.ps1");
  }

  async frontmostAppIdentity(): Promise<string | null> {
    if (this.platform === "darwin") {
      const result = await this.executor.run("/usr/bin/osascript", [
        "-e",
        'tell application "System Events" to get bundle identifier of first application process whose frontmost is true',
      ]);
      return nonempty(result.stdout);
    }
    if (this.platform === "win32") {
      const result = await this.runWindowsHelper("foreground");
      return nonempty(result.stdout);
    }
    throw new Error(`Paste is unsupported on platform ${this.platform}`);
  }

  async paste(text: string, replacementTarget?: ReplacementTarget): Promise<void> {
    if (replacementTarget && (await this.canReplace(replacementTarget))) {
      await this.keystroke("undo");
      await this.sleep(UX_MILLISECONDS.replacementPasteDelay);
    }
    this.clipboard.writeText(text);
    await this.keystroke("paste");
  }

  private async canReplace(target: ReplacementTarget): Promise<boolean> {
    const currentIdentity = await this.frontmostAppIdentity();
    return !(target.appIdentity && currentIdentity && target.appIdentity !== currentIdentity);
  }

  private async keystroke(action: "paste" | "undo"): Promise<void> {
    if (this.platform === "darwin") {
      await this.executor.run("/usr/bin/osascript", [
        "-e",
        SYSTEM_EVENTS_SCRIPT(action === "paste" ? "v" : "z"),
      ]);
      return;
    }
    if (this.platform === "win32") {
      await this.runWindowsHelper(action);
      return;
    }
    throw new Error(`Paste is unsupported on platform ${this.platform}`);
  }

  private runWindowsHelper(action: "foreground" | "paste" | "undo"): Promise<CommandResult> {
    return this.executor.run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      this.windowsHelperPath,
      "-Action",
      action,
    ]);
  }
}

export const systemCommandExecutor: CommandExecutor = {
  async run(executable, args) {
    const result = await execFileAsync(executable, [...args], { encoding: "utf8" });
    return { stdout: result.stdout, stderr: result.stderr };
  },
};

export async function createSystemPasteEngine(
  platform: NodeJS.Platform = process.platform,
): Promise<PasteEngine> {
  const { clipboard } = await import("electron");
  return new PasteEngine({
    platform,
    clipboard,
    executor: systemCommandExecutor,
  });
}

function nonempty(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
