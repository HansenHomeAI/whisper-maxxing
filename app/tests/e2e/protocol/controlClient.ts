import net from "node:net";

export type DictationTarget = "swift" | "electron";

export interface SessionMetrics {
  sessionId: string;
  transcriptionProfile?: string;
  prebufferMilliseconds: number;
  audioDurationMilliseconds: number;
  captureStartedAtISO8601?: string;
  captureStoppedAtISO8601?: string;
  captureWallClockMilliseconds?: number;
  activeAudioMilliseconds?: number;
  captureDroppedMilliseconds?: number;
  captureCoverageRatio?: number;
  transcriptionMode?: string;
  transcriptionMilliseconds?: number;
  queueWaitMilliseconds?: number;
  completedAtISO8601?: string;
}

export interface SessionResult {
  sessionId: string;
  text: string;
  metrics: SessionMetrics;
  salvagePath?: string;
  errorMessage?: string;
}

export interface StatusPayload {
  recording: boolean;
  activeSessionId?: string;
  processInstanceId?: string;
  recordingProfile?: string;
  pendingCount: number;
  engineReady: boolean;
  engineHealthMessage?: string;
  engineStartupMilliseconds?: number;
  prebufferAvailableMilliseconds: number;
  preferredInputDevice?: string;
  defaultInputDevice?: string;
  serverState: string;
  robustServerState?: string;
  availableDiskSpaceBytes?: number;
  lowDiskSpaceMessage?: string;
}

export interface ControlResponse {
  ok: boolean;
  error?: string;
  recording?: boolean;
  pendingCount?: number;
  sessionId?: string;
  resultAvailable?: boolean;
  result?: SessionResult;
  status?: StatusPayload;
}

export interface ControlTarget {
  host: string;
  port: number;
  target: DictationTarget;
  requestTimeoutMilliseconds: number;
  resultTimeoutMilliseconds: number;
  captureMilliseconds: number;
}

export function targetFromEnvironment(): ControlTarget {
  const target = process.env.WD_TARGET === "swift" ? "swift" : "electron";
  const host = process.env.WD_CONTROL_HOST ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error(`WD_CONTROL_HOST must be loopback-only, received ${host}`);
  }
  return {
    host,
    port: numberFromEnvironment("WD_CONTROL_PORT", target === "swift" ? 44123 : 44124),
    target,
    requestTimeoutMilliseconds: numberFromEnvironment("WD_REQUEST_TIMEOUT_MS", 5_000),
    resultTimeoutMilliseconds: numberFromEnvironment(
      "WD_RESULT_TIMEOUT_MS",
      target === "swift" ? 240_000 : 30_000,
    ),
    captureMilliseconds: numberFromEnvironment(
      "WD_CAPTURE_MS",
      target === "swift" ? 750 : 350,
    ),
  };
}

export async function sendControl(
  target: ControlTarget,
  command: string,
  sessionId?: string,
  deliveryOutcome?: "delivered" | "pasteFailed" | "noOutput",
): Promise<ControlResponse> {
  const request = JSON.stringify({
    command,
    ...(sessionId ? { sessionId } : {}),
    ...(deliveryOutcome ? { deliveryOutcome } : {}),
  }) + "\n";

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: target.host, port: target.port });
    let response = "";
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      if (error) {
        reject(error);
        return;
      }

      const line = response.split("\n", 1)[0]?.trim();
      if (!line) {
        reject(new Error(`Control command ${command} returned an empty response`));
        return;
      }

      try {
        resolve(JSON.parse(line) as ControlResponse);
      } catch (parseError) {
        reject(
          new Error(
            `Control command ${command} returned invalid JSON: ${line}`,
            { cause: parseError },
          ),
        );
      }
    };

    socket.setTimeout(target.requestTimeoutMilliseconds, () => {
      finish(new Error(`Control command ${command} timed out`));
    });
    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
      if (response.includes("\n")) {
        finish();
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => finish());
  });
}

export async function waitForEngineReady(target: ControlTarget): Promise<StatusPayload> {
  const deadline = Date.now() + target.resultTimeoutMilliseconds;
  let lastHealth = "status unavailable";

  while (Date.now() < deadline) {
    try {
      const response = await sendControl(target, "status");
      if (!response.ok || !response.status) {
        lastHealth = response.error ?? "status payload missing";
      } else if (response.status.engineReady) {
        return response.status;
      } else {
        lastHealth = response.status.engineHealthMessage ?? "capture engine not ready";
      }
    } catch (error) {
      lastHealth = error instanceof Error ? error.message : String(error);
    }
    await sleep(100);
  }

  throw new Error(`Capture engine was not ready before timeout: ${lastHealth}`);
}

export async function waitForResult(
  target: ControlTarget,
  sessionId: string,
): Promise<SessionResult> {
  const deadline = Date.now() + target.resultTimeoutMilliseconds;

  while (Date.now() < deadline) {
    const response = await sendControl(target, "nextResult", sessionId);
    if (!response.ok) {
      throw new Error(response.error ?? `nextResult failed for ${sessionId}`);
    }
    if (response.resultAvailable && response.result) {
      return response.result;
    }
    await sleep(150);
  }

  throw new Error(`No result arrived for ${sessionId} before timeout`);
}

export async function waitForPendingCount(
  target: ControlTarget,
  expected: number,
  timeoutMilliseconds = target.resultTimeoutMilliseconds,
): Promise<StatusPayload> {
  const deadline = Date.now() + timeoutMilliseconds;

  while (Date.now() < deadline) {
    const response = await sendControl(target, "status");
    if (!response.ok) {
      throw new Error(response.error ?? "status failed while waiting for pending work");
    }
    if (response.ok && response.status?.pendingCount === expected) {
      return response.status;
    }
    await sleep(100);
  }

  throw new Error(`pendingCount did not become ${expected} before timeout`);
}

export async function drainOwnedSessions(
  target: ControlTarget,
  sessionIds: Iterable<string>,
): Promise<void> {
  const ids = [...sessionIds];
  const deadline = Date.now() + target.resultTimeoutMilliseconds;
  let quietChecks = 0;

  while (Date.now() < deadline) {
    const statusResponse = await sendControl(target, "status");
    if (!statusResponse.ok || !statusResponse.status) {
      throw new Error(statusResponse.error ?? "status failed during cleanup");
    }
    if (statusResponse.status.recording) {
      const activeSessionId = statusResponse.status.activeSessionId;
      if (!activeSessionId || !ids.includes(activeSessionId)) {
        throw new Error("Refusing to cancel a recording not owned by this test.");
      }
      const cancelled = await sendControl(target, "cancel", activeSessionId);
      if (!cancelled.ok) {
        throw new Error(cancelled.error ?? "cancel failed during cleanup");
      }
    }

    let drained = 0;
    for (const sessionId of ids) {
      const response = await sendControl(target, "nextResult", sessionId);
      if (!response.ok) {
        throw new Error(response.error ?? `cleanup failed for ${sessionId}`);
      }
      if (response.resultAvailable) {
        drained += 1;
      }
    }

    const after = await sendControl(target, "status");
    if (!after.ok || !after.status) {
      throw new Error(after.error ?? "status failed after cleanup drain");
    }
    if (after.status.pendingCount === 0 && drained === 0) {
      quietChecks += 1;
      if (quietChecks >= 3) {
        return;
      }
    } else {
      quietChecks = 0;
    }
    await sleep(150);
  }

  throw new Error("Owned sessions did not drain before cleanup timeout");
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function numberFromEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}
