import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { dirname, extname } from "node:path";

import type {
  ListeningProcess,
  ManagedProcess,
  ProcessRunOptions,
  ProcessRunResult,
  ProcessSpawner,
} from "./types.js";

class NodeManagedProcess implements ManagedProcess {
  readonly pid: number;
  readonly command: string;
  private running = true;
  private readonly exited: Promise<void>;

  constructor(
    command: string,
    private readonly child: ReturnType<typeof spawn>,
  ) {
    this.command = command;
    this.pid = child.pid ?? -1;
    this.exited = new Promise((resolve) => {
      if (child.exitCode !== null) {
        this.running = false;
        resolve();
        return;
      }
      child.once("exit", () => {
        this.running = false;
        resolve();
      });
      child.once("error", () => {
        this.running = false;
        resolve();
      });
    });
  }

  isRunning(): boolean {
    return this.running && this.child.exitCode === null;
  }

  terminate(): void {
    this.child.kill("SIGTERM");
  }

  kill(): void {
    this.child.kill("SIGKILL");
  }

  async waitForExit(): Promise<void> {
    await this.exited;
  }
}

export class NodeProcessSpawner implements ProcessSpawner {
  async spawnServer(
    command: string,
    args: readonly string[],
    logPath: string,
  ): Promise<ManagedProcess> {
    await mkdir(dirname(logPath), { recursive: true });
    const log = await open(logPath, "a");
    const resolved = executable(command, args);
    const child = spawn(resolved.command, resolved.args, {
      stdio: ["ignore", log.fd, log.fd],
      windowsHide: true,
    });
    await waitForSpawn(child);
    if (child.exitCode !== null) {
      await log.close();
    } else {
      child.once("exit", () => void log.close());
      child.once("error", () => void log.close());
    }
    return new NodeManagedProcess(command, child);
  }

  async run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions,
  ): Promise<ProcessRunResult> {
    const resolved = executable(command, args);
    return new Promise((resolve, reject) => {
      const child = spawn(resolved.command, resolved.args, {
        env: options.environment,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill("SIGKILL");
        resolve({ exitCode: child.exitCode, stdout, stderr, timedOut: true });
      }, options.timeoutMilliseconds);
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
      });
      child.once("exit", (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve({ exitCode: code, stdout, stderr, timedOut: false });
        }
      });
    });
  }

  async listeningProcesses(port: number): Promise<ListeningProcess[]> {
    if (process.platform === "win32") {
      return this.windowsListeningProcesses(port);
    }
    const result = await this.run(
      "/usr/sbin/lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { timeoutMilliseconds: 2_000 },
    ).catch(() => null);
    if (result === null || result.timedOut || result.exitCode !== 0) {
      return [];
    }
    const pids = result.stdout
      .split(/\r?\n/u)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
    const processes = await Promise.all(
      pids.map(async (pid) => {
        const details = await this.run(
          "/bin/ps",
          ["-p", String(pid), "-o", "command="],
          { timeoutMilliseconds: 2_000 },
        ).catch(() => null);
        if (
          details === null ||
          details.timedOut ||
          details.exitCode !== 0 ||
          details.stdout.trim().length === 0
        ) {
          return null;
        }
        return { pid, command: details.stdout.trim() };
      }),
    );
    return processes.filter(
      (process): process is ListeningProcess => process !== null,
    );
  }

  async terminatePid(pid: number, force: boolean): Promise<void> {
    try {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  }

  processIsRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async windowsListeningProcesses(
    port: number,
  ): Promise<ListeningProcess[]> {
    const script = [
      `$rows = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue`,
      "$rows | ForEach-Object {",
      "  $p = Get-CimInstance Win32_Process -Filter \"ProcessId=$($_.OwningProcess)\"",
      "  [PSCustomObject]@{ pid = $_.OwningProcess; command = $p.CommandLine }",
      "} | ConvertTo-Json -Compress",
    ].join("; ");
    const result = await this.run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeoutMilliseconds: 2_000 },
    ).catch(() => null);
    if (result === null || result.timedOut || result.exitCode !== 0) {
      return [];
    }
    const trimmed = result.stdout.trim();
    if (trimmed.length === 0) {
      return [];
    }
    const decoded = JSON.parse(trimmed) as
      | { pid: number; command: string }
      | { pid: number; command: string }[];
    return Array.isArray(decoded) ? decoded : [decoded];
  }
}

function executable(
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  if (extname(command).toLowerCase() === ".mjs") {
    return { command: process.execPath, args: [command, ...args] };
  }
  return { command, args: [...args] };
}

function waitForSpawn(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}
