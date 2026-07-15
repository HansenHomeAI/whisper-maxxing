import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const wdctlPath = path.resolve(import.meta.dirname, "../../bin/wdctl.mjs");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("wdctl", () => {
  it("prints one structured error when the daemon binary cannot spawn", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wdctl-error-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        controlHost: "127.0.0.1",
        controlPort: await findAvailablePort(),
        daemonBinaryPath: path.join(directory, "missing-daemon"),
      }),
      "utf8",
    );

    const result = await runWdctl(["open-settings"], configPath);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "") as unknown).toMatchObject({
      ok: false,
      error: expect.stringContaining("Unable to start the dictation daemon"),
      clientObservedMilliseconds: expect.any(Number),
    });
  });
});

function runWdctl(
  arguments_: readonly string[],
  configPath: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wdctlPath, ...arguments_], {
      env: { ...process.env, WDCTL_CONFIG: configPath },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a control port."));
        return;
      }
      const { port } = address;
      server.close((error) => (error === undefined ? resolve(port) : reject(error)));
    });
  });
}
