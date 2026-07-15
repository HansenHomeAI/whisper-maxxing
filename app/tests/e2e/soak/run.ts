import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  sendControl,
  sleep,
  targetFromEnvironment,
  waitForEngineReady,
  waitForPendingCount,
  waitForResult,
} from "../protocol/controlClient";

interface CycleReport {
  cycle: number;
  sessionId: string;
  latencyMilliseconds: number;
  audioDurationMilliseconds: number;
  transcriptionMode: string | null;
  outcome: "transcript" | "no-speech" | "error";
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const target = targetFromEnvironment();
  const cycles = positiveInteger("SOAK_CYCLES", 50);
  const reportPath = path.resolve(process.env.WD_SOAK_REPORT ?? "soak-report.json");
  const pidStart = listenerPid(target.port);
  const reports: CycleReport[] = [];

  await waitForEngineReady(target);
  const initialStatus = await sendControl(target, "status");
  if (!initialStatus.ok || initialStatus.status?.recording || initialStatus.status?.pendingCount !== 0) {
    throw new Error("Soak requires an idle daemon with pendingCount 0");
  }

  for (let index = 0; index < cycles; index += 1) {
    const cycleStartedAt = performance.now();
    const started = await sendControl(target, "start");
    if (!started.ok || !started.sessionId) {
      throw new Error(`Cycle ${index + 1} failed to start: ${started.error ?? "sessionId missing"}`);
    }
    const sessionId = started.sessionId;
    await sleep(target.captureMilliseconds);

    const stopped = await sendControl(target, "stop");
    if (!stopped.ok || stopped.sessionId !== sessionId) {
      throw new Error(`Cycle ${index + 1} failed to stop its own session: ${stopped.error ?? "id mismatch"}`);
    }

    const result = await waitForResult(target, sessionId);
    if (result.sessionId !== sessionId) {
      throw new Error(`Cycle ${index + 1} received result for ${result.sessionId}`);
    }
    if (result.metrics.audioDurationMilliseconds <= 0) {
      throw new Error(`Cycle ${index + 1} produced empty audio metrics`);
    }

    const duplicate = await sendControl(target, "nextResult", sessionId);
    if (!duplicate.ok || duplicate.resultAvailable) {
      throw new Error(`Cycle ${index + 1} delivered session ${sessionId} more than once`);
    }
    await waitForPendingCount(target, 0);

    const latencyMilliseconds = performance.now() - cycleStartedAt;
    const outcome = result.errorMessage ? "error" : result.text.trim() ? "transcript" : "no-speech";
    reports.push({
      cycle: index + 1,
      sessionId,
      latencyMilliseconds,
      audioDurationMilliseconds: result.metrics.audioDurationMilliseconds,
      transcriptionMode: result.metrics.transcriptionMode ?? null,
      outcome,
    });
    process.stdout.write(
      `cycle ${index + 1}/${cycles} ${sessionId} ${outcome} ${latencyMilliseconds.toFixed(1)}ms\n`,
    );
  }

  const pidEnd = listenerPid(target.port);
  if (pidStart === null || pidEnd === null) {
    throw new Error(`Unable to determine listener PID on port ${target.port}`);
  }
  if (pidStart !== pidEnd && process.env.WD_EXPECT_RESTART !== "1") {
    throw new Error(`Daemon restarted unexpectedly during soak: pid ${pidStart} -> ${pidEnd}`);
  }

  const latencies = reports.map((report) => report.latencyMilliseconds).sort((a, b) => a - b);
  const report = {
    schemaVersion: 1,
    target: target.target,
    host: target.host,
    port: target.port,
    cyclesRequested: cycles,
    cyclesCompleted: reports.length,
    resultsLost: cycles - reports.length,
    resultsDuplicated: 0,
    pidStart,
    pidEnd,
    p50Milliseconds: percentile(latencies, 0.5),
    p95Milliseconds: percentile(latencies, 0.95),
    generatedAt: new Date().toISOString(),
    cycles: reports,
  };

  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  JSON.parse(await readFile(reportPath, "utf8"));
  process.stdout.write(`${JSON.stringify({ ...report, cycles: undefined, reportPath })}\n`);
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) {
    throw new Error("Cannot calculate a percentile without samples");
  }
  const index = Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1);
  return values[index] as number;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function listenerPid(port: number): number | null {
  const explicitPid = Number(process.env.WD_DAEMON_PID);
  if (Number.isInteger(explicitPid) && explicitPid > 0) {
    return explicitPid;
  }

  try {
    if (process.platform === "win32") {
      const command = `(Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object -First 1 -ExpandProperty OwningProcess)`;
      const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
        encoding: "utf8",
      });
      const pid = Number(output.trim());
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    }

    const output = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], {
      encoding: "utf8",
    });
    const match = output.match(/^p(\d+)$/m);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}
