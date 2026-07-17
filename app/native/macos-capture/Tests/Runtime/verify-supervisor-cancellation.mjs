import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

const binary = resolve(
  process.argv[2] ?? ".build/debug/whisper-mac-capture",
);

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

function privateDirectories(pid) {
  return readdirSync("/tmp")
    .filter((name) => name.startsWith(`wmc-${pid}-`))
    .map((name) => `/tmp/${name}`);
}

function launchdJob(pid) {
  const line = execFileSync("/bin/launchctl", ["list"], { encoding: "utf8" })
    .split("\n")
    .find((candidate) =>
      candidate.includes(`com.whispermaxxing.capture.${pid}.`),
    );
  if (!line) return undefined;
  const fields = line.trim().split(/\s+/u);
  return {
    label: fields.at(-1),
    pid: Number(fields[0]) || undefined,
  };
}

function decodeFrames(data) {
  const frames = [];
  let offset = 0;
  while (offset + 5 <= data.length) {
    const type = data[offset];
    const payloadLength = data.readUInt32LE(offset + 1);
    if (offset + 5 + payloadLength > data.length) {
      throw new Error(`partial frame at byte ${offset}`);
    }
    frames.push({
      type,
      payloadLength,
      payload: data.subarray(offset + 5, offset + 5 + payloadLength),
    });
    offset += 5 + payloadLength;
  }
  if (offset !== data.length) {
    throw new Error(`${data.length - offset} trailing protocol bytes`);
  }
  return frames;
}

function validateProtocol(name, frames) {
  if (frames[0]?.type !== 1 || frames.at(-1)?.type !== 4) {
    throw new Error(`${name}: stream must start ready and end stopped`);
  }
  let errorSeen = false;
  let stoppedCount = 0;
  for (const [index, frame] of frames.entries()) {
    if (frame.type === 1 && index !== 0) {
      throw new Error(`${name}: duplicate ready frame`);
    }
    if (frame.type === 2 && errorSeen) {
      throw new Error(`${name}: PCM followed an error frame`);
    }
    if (frame.type === 3) {
      if (errorSeen) throw new Error(`${name}: duplicate error frame`);
      errorSeen = true;
    }
    if (frame.type === 4) stoppedCount += 1;
  }
  if (stoppedCount !== 1) {
    throw new Error(`${name}: expected one stopped frame, got ${stoppedCount}`);
  }
}

async function waitUntil(description, predicate, timeoutMilliseconds = 15_000) {
  const deadline = performance.now() + timeoutMilliseconds;
  while (performance.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function runScenario({
  name,
  pausePhase,
  workerMode,
  cleanupFailure,
  cleanupCommandTimeout = false,
  connected = false,
  earlyEntry = false,
}) {
  const earlyMarker = earlyEntry
    ? `/tmp/wmc-runtime-entry-${process.pid}-${Date.now()}`
    : undefined;
  const child = spawn(binary, [], {
    env: {
      ...process.env,
      ...(pausePhase ? { WMC_TEST_PAUSE_PHASE: pausePhase } : {}),
      ...(workerMode ? { WMC_TEST_WORKER_MODE: workerMode } : {}),
      ...(cleanupFailure
        ? { WMC_TEST_CLEANUP_FAILURE: cleanupFailure }
        : {}),
      ...(cleanupCommandTimeout ? { WMC_TEST_CLEANUP_COMMAND: "hang" } : {}),
      ...(earlyMarker ? { WMC_TEST_EARLY_ENTRY_MARKER: earlyMarker } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  const errors = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => errors.push(chunk));

  let observedJob;
  if (earlyEntry) {
    await waitUntil("early process-entry marker", () => existsSync(earlyMarker));
    unlinkSync(earlyMarker);
    observedJob = launchdJob(child.pid);
    if (observedJob) {
      throw new Error(`${name}: launchd job existed at the entry barrier`);
    }
  } else if (connected) {
    observedJob = await waitUntil("connected worker", () => {
      const job = launchdJob(child.pid);
      const directories = privateDirectories(child.pid);
      if (!job?.pid || directories.length !== 1) return undefined;
      const socketName = `${directories[0]}/capture.sock`;
      try {
        execFileSync("/bin/test", ["!", "-S", socketName]);
        return job;
      } catch {
        return undefined;
      }
    });
    process.kill(observedJob.pid, "SIGSTOP");
  } else {
    const markerName = `runtime-test-${pausePhase}`;
    await waitUntil(`${pausePhase} marker`, () => {
      const directories = privateDirectories(child.pid);
      if (directories.length !== 1) return false;
      try {
        execFileSync("/bin/test", ["-f", `${directories[0]}/${markerName}`]);
        return true;
      } catch {
        return false;
      }
    });
    observedJob = launchdJob(child.pid);
    if (pausePhase === "before-submit" && observedJob) {
      throw new Error(`${name}: launchd job existed before submission`);
    }
    if (pausePhase === "after-submit-before-connect" && !observedJob) {
      throw new Error(`${name}: launchd job missing after submission`);
    }
  }

  const signalTime = performance.now();
  child.kill("SIGTERM");
  const result = await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectExit(new Error(`${name}: supervisor exceeded 1 second cleanup bound`));
    }, 1_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });
  const elapsedMilliseconds = performance.now() - signalTime;
  await sleep(75);

  const frames = decodeFrames(Buffer.concat(output));
  validateProtocol(name, frames);
  const terminalFrames = frames.filter(({ type }) => type === 4);
  const stderr = Buffer.concat(errors).toString("utf8");
  const remainingJob = launchdJob(child.pid);
  const remainingDirectories = privateDirectories(child.pid);
  let workerAlive = false;
  if (observedJob?.pid) {
    try {
      process.kill(observedJob.pid, 0);
      workerAlive = true;
    } catch {
      workerAlive = false;
    }
  }

  const expectedCode = cleanupFailure || cleanupCommandTimeout ? 70 : 0;
  if (result.signal || result.code !== expectedCode) {
    throw new Error(
      `${name}: expected exit ${expectedCode}, received ${result.code}/${result.signal}`,
    );
  }
  if (elapsedMilliseconds >= 1_000) {
    throw new Error(`${name}: cleanup took ${elapsedMilliseconds}ms`);
  }
  if (
    terminalFrames.length !== 1 ||
    frames.at(-1)?.type !== 4
  ) {
    throw new Error(`${name}: invalid terminal sequence ${JSON.stringify(frames)}`);
  }
  if (remainingJob || remainingDirectories.length > 0 || workerAlive) {
    throw new Error(
      `${name}: leaked cleanup state ${JSON.stringify({
        remainingJob,
        remainingDirectories,
        workerAlive,
      })}`,
    );
  }
  if (cleanupFailure) {
    const expectedError = `Injected ${cleanupFailure} cleanup failure.`;
    if (!stderr.includes("cleanup failed:") || !stderr.includes(expectedError)) {
      throw new Error(`${name}: cleanup error was not visible: ${stderr}`);
    }
  } else if (cleanupCommandTimeout) {
    if (
      !stderr.includes("forced cleanup failed:") ||
      !stderr.includes("Timed out running bounded command:")
    ) {
      throw new Error(`${name}: command timeout was not visible: ${stderr}`);
    }
  } else if (stderr.length > 0) {
    throw new Error(`${name}: unexpected stderr: ${stderr}`);
  }

  console.log(JSON.stringify({
    name,
    supervisorPID: child.pid,
    workerPID: observedJob?.pid ?? null,
    elapsedMilliseconds: Number(elapsedMilliseconds.toFixed(1)),
    exitCode: result.code,
    terminalCount: terminalFrames.length,
    frameTypes: frames.map(({ type }) => type),
    jobGone: !remainingJob,
    workerGone: !workerAlive,
    privateDirectoryGone: remainingDirectories.length === 0,
    cleanupErrorVisible:
      cleanupFailure || cleanupCommandTimeout ? true : undefined,
  }));
}

async function runStartupFailure() {
  const name = "WorkerProtocol.startupFailure.runtime";
  const child = spawn(binary, [], {
    env: { ...process.env, WMC_TEST_WORKER_MODE: "startup-failure" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  const errors = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => errors.push(chunk));
  const result = await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectExit(new Error(`${name}: timed out`));
    }, 15_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });
  await sleep(75);
  const frames = decodeFrames(Buffer.concat(output));
  validateProtocol(name, frames);
  if (frames.map(({ type }) => type).join(",") !== "1,3,4") {
    throw new Error(`${name}: expected ready,error,stopped`);
  }
  const ready = JSON.parse(frames[0].payload.toString("utf8"));
  if (ready.defaultInputDeviceName !== null) {
    throw new Error(`${name}: synthetic ready device was not null`);
  }
  if (result.code !== 70 || result.signal) {
    throw new Error(`${name}: expected exit 70, got ${JSON.stringify(result)}`);
  }
  if (launchdJob(child.pid) || privateDirectories(child.pid).length > 0) {
    throw new Error(`${name}: leaked launchd or private-directory state`);
  }
  console.log(JSON.stringify({
    name,
    exitCode: result.code,
    frameTypes: frames.map(({ type }) => type),
    syntheticDevice: ready.defaultInputDeviceName,
    jobGone: true,
    privateDirectoryGone: true,
  }));
}

async function runSupervisorSIGKILLOrphanCleanup() {
  const name = "WorkerCleanup.supervisorSIGKILL.runtime";
  const child = spawn(binary, [], {
    env: { ...process.env, WMC_TEST_WORKER_MODE: "orphan-cleanup" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const job = await waitUntil("orphan-test worker connection", () => {
    const currentJob = launchdJob(child.pid);
    const directories = privateDirectories(child.pid);
    if (!currentJob?.pid || directories.length !== 1) return undefined;
    try {
      execFileSync("/bin/test", ["!", "-S", `${directories[0]}/capture.sock`]);
      return currentJob;
    } catch {
      return undefined;
    }
  });
  const signalTime = performance.now();
  child.kill("SIGKILL");
  await new Promise((resolveExit) => child.once("exit", resolveExit));
  await waitUntil("worker-owned orphan cleanup", () => {
    let workerAlive = false;
    try {
      process.kill(job.pid, 0);
      workerAlive = true;
    } catch {
      workerAlive = false;
    }
    return !workerAlive
      && !launchdJob(child.pid)
      && privateDirectories(child.pid).length === 0;
  }, 2_000);
  const elapsedMilliseconds = performance.now() - signalTime;
  console.log(JSON.stringify({
    name,
    supervisorPID: child.pid,
    workerPID: job.pid,
    supervisorSignal: "SIGKILL",
    elapsedMilliseconds: Number(elapsedMilliseconds.toFixed(1)),
    workerGone: true,
    jobGone: true,
    socketGone: true,
    privateDirectoryGone: true,
  }));
}

await runScenario({
  name: "SupervisorCancellation.earlyEntryBeforeSubmit.runtime",
  earlyEntry: true,
});
await runScenario({
  name: "SupervisorCancellation.beforeSubmit.runtime",
  pausePhase: "before-submit",
});
await runScenario({
  name: "SupervisorCancellation.afterSubmitBeforeConnect.runtime",
  pausePhase: "after-submit-before-connect",
});
await runScenario({
  name: "SupervisorCancellation.connectedUnresponsive.runtime",
  workerMode: "unresponsive",
  connected: true,
});
await runScenario({
  name: "LaunchdCleanup.removalFailureVisibility.runtime",
  pausePhase: "before-submit",
  cleanupFailure: "launchd-removal",
});
await runScenario({
  name: "LaunchdCleanup.privateDirectoryFailureVisibility.runtime",
  pausePhase: "before-submit",
  cleanupFailure: "private-directory",
});
await runScenario({
  name: "LaunchdCleanup.commandTimeoutBounded.runtime",
  pausePhase: "before-submit",
  cleanupCommandTimeout: true,
});
await runStartupFailure();
await runSupervisorSIGKILLOrphanCleanup();

console.log("SUPERVISOR RUNTIME CANCELLATION TESTS PASSED");
