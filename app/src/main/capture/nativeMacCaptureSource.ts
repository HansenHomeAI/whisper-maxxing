import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

import type {
  CapturedAudioFrame,
  CaptureSource,
  CaptureSourceInfo,
  CaptureSourceStartOptions,
} from "./captureSource.js";
import {
  NativeMacCaptureProtocolParser,
  type NativeMacCaptureMessage,
} from "./nativeMacCaptureProtocol.js";

const DEFAULT_STOP_TIMEOUT_MILLISECONDS = 1_000;
const MAXIMUM_STDERR_CONTEXT_BYTES = 8_192;

interface NativeMacCaptureChildProcess {
  readonly pid?: number | undefined;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(
    event: "error",
    listener: (error: Error) => void,
  ): this;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export interface NativeMacCaptureSourceOptions {
  binaryPath: string;
  spawnProcess?: (
    binaryPath: string,
    arguments_: string[],
  ) => NativeMacCaptureChildProcess;
  stopTimeoutMilliseconds?: number;
  now?: () => number;
}

interface NativeCaptureState {
  child: NativeMacCaptureChildProcess;
  parser: NativeMacCaptureProtocolParser;
  startOptions: CaptureSourceStartOptions;
  startDeferred: Deferred<CaptureSourceInfo>;
  exitDeferred: Deferred<void>;
  startSettled: boolean;
  exitSettled: boolean;
  stopping: boolean;
  failureSurfaced: boolean;
  ignoreFrames: boolean;
  stderrContext: Buffer;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

export class NativeMacCaptureSource implements CaptureSource {
  private readonly binaryPath: string;
  private readonly spawnProcess: NonNullable<
    NativeMacCaptureSourceOptions["spawnProcess"]
  >;
  private readonly stopTimeoutMilliseconds: number;
  private readonly now: () => number;
  private active: NativeCaptureState | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(options: NativeMacCaptureSourceOptions) {
    if (options.binaryPath.trim().length === 0) {
      throw new Error("Native macOS capture binary path must not be empty.");
    }
    const stopTimeoutMilliseconds =
      options.stopTimeoutMilliseconds ?? DEFAULT_STOP_TIMEOUT_MILLISECONDS;
    if (
      !Number.isFinite(stopTimeoutMilliseconds) ||
      stopTimeoutMilliseconds <= 0
    ) {
      throw new Error("Native macOS capture stop timeout must be positive.");
    }
    this.binaryPath = options.binaryPath;
    this.spawnProcess = options.spawnProcess ?? spawnNativeCaptureProcess;
    this.stopTimeoutMilliseconds = stopTimeoutMilliseconds;
    this.now = options.now ?? (() => performance.now());
  }

  get childProcessId(): number | null {
    return this.active?.child.pid ?? null;
  }

  start(options: CaptureSourceStartOptions): Promise<CaptureSourceInfo> {
    if (this.active !== null || this.stopPromise !== null) {
      return this.stop().then(() => this.startNow(options));
    }
    return this.startNow(options);
  }

  stop(): Promise<void> {
    if (this.stopPromise !== null) {
      return this.stopPromise;
    }
    const state = this.active;
    if (state === null) {
      return Promise.resolve();
    }
    state.stopping = true;
    state.ignoreFrames = true;
    if (!state.startSettled) {
      this.rejectStart(
        state,
        new Error("Native macOS capture stopped during startup."),
      );
    }
    const stopping = this.stopState(state).finally(() => {
      if (this.stopPromise === stopping) {
        this.stopPromise = null;
      }
    });
    this.stopPromise = stopping;
    return stopping;
  }

  private startNow(options: CaptureSourceStartOptions): Promise<CaptureSourceInfo> {
    const arguments_ = nativeCaptureArguments(options);
    let child: NativeMacCaptureChildProcess;
    try {
      child = this.spawnProcess(this.binaryPath, arguments_);
    } catch (error) {
      return Promise.reject(
        new Error(
          `Unable to start native macOS capture helper: ${toError(error).message}`,
          { cause: error },
        ),
      );
    }

    const state: NativeCaptureState = {
      child,
      parser: new NativeMacCaptureProtocolParser(),
      startOptions: options,
      startDeferred: deferred<CaptureSourceInfo>(),
      exitDeferred: deferred<void>(),
      startSettled: false,
      exitSettled: false,
      stopping: false,
      failureSurfaced: false,
      ignoreFrames: false,
      stderrContext: Buffer.alloc(0),
    };
    this.active = state;

    child.stdout.on("data", (chunk: Buffer | string) => {
      this.handleStdout(state, chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.handleStderr(state, chunk);
    });
    child.once("error", (error) => {
      this.handleProcessError(state, error);
    });
    child.once("exit", (code, signal) => {
      this.handleExit(state, code, signal);
    });

    if (child.exitCode !== null || child.signalCode !== null) {
      queueMicrotask(() => {
        this.handleExit(state, child.exitCode, child.signalCode);
      });
    }
    return state.startDeferred.promise;
  }

  private handleStdout(
    state: NativeCaptureState,
    chunk: Buffer | string,
  ): void {
    if (state.exitSettled || state.ignoreFrames) {
      return;
    }
    let messages: NativeMacCaptureMessage[];
    try {
      messages = state.parser.push(
        typeof chunk === "string" ? Buffer.from(chunk) : chunk,
      );
    } catch (error) {
      state.ignoreFrames = true;
      this.surfaceFailure(
        state,
        new Error(
          `Native macOS capture protocol error: ${toError(error).message}`,
          { cause: error },
        ),
      );
      return;
    }

    for (const message of messages) {
      if (state.ignoreFrames) {
        return;
      }
      this.handleMessage(state, message);
    }
  }

  private handleMessage(
    state: NativeCaptureState,
    message: NativeMacCaptureMessage,
  ): void {
    switch (message.type) {
      case "ready":
        if (!state.startSettled) {
          state.startSettled = true;
          state.startDeferred.resolve({
            defaultInputDeviceName: message.defaultInputDeviceName,
          });
        }
        return;
      case "pcm": {
        const frame: CapturedAudioFrame = {
          samples: message.samples,
          timestampMilliseconds: this.now(),
        };
        try {
          state.startOptions.onFrame(frame);
        } catch (error) {
          state.ignoreFrames = true;
          this.surfaceFailure(
            state,
            new Error(
              `Native macOS capture frame consumer failed: ${toError(error).message}`,
              { cause: error },
            ),
          );
        }
        return;
      }
      case "error":
        state.ignoreFrames = true;
        this.surfaceFailure(
          state,
          new Error(`Native macOS capture helper error: ${message.message}`),
        );
        return;
      case "stopped":
        state.ignoreFrames = true;
        return;
    }
  }

  private handleStderr(
    state: NativeCaptureState,
    chunk: Buffer | string,
  ): void {
    if (state.exitSettled) {
      return;
    }
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    state.stderrContext = Buffer.concat([state.stderrContext, bytes]).subarray(
      -MAXIMUM_STDERR_CONTEXT_BYTES,
    );
  }

  private handleProcessError(state: NativeCaptureState, error: Error): void {
    if (state.exitSettled) {
      return;
    }
    this.finishExit(state);
    if (!state.stopping) {
      this.surfaceFailure(
        state,
        new Error(
          `Native macOS capture helper process failed: ${error.message}`,
          { cause: error },
        ),
      );
    }
  }

  private handleExit(
    state: NativeCaptureState,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (state.exitSettled) {
      return;
    }
    let protocolError: Error | null = null;
    try {
      state.parser.finish();
    } catch (error) {
      protocolError = new Error(
        `Native macOS capture protocol error: ${toError(error).message}`,
        { cause: error },
      );
    }
    this.finishExit(state);
    if (state.stopping) {
      return;
    }
    const error =
      protocolError ??
      new Error(
        `Native macOS capture helper exited unexpectedly ${formatExit(code, signal)}${formatStderr(state.stderrContext)}.`,
      );
    this.surfaceFailure(state, error);
  }

  private finishExit(state: NativeCaptureState): void {
    state.exitSettled = true;
    state.ignoreFrames = true;
    state.exitDeferred.resolve();
    if (this.active === state) {
      this.active = null;
    }
  }

  private surfaceFailure(state: NativeCaptureState, error: Error): void {
    this.rejectStart(state, error);
    if (state.failureSurfaced) {
      return;
    }
    state.failureSurfaced = true;
    state.startOptions.onError(error);
  }

  private rejectStart(state: NativeCaptureState, error: Error): void {
    if (!state.startSettled) {
      state.startSettled = true;
      state.startDeferred.reject(error);
    }
  }

  private async stopState(state: NativeCaptureState): Promise<void> {
    if (state.exitSettled) {
      return;
    }
    const errors: Error[] = [];
    try {
      state.child.kill("SIGTERM");
    } catch (error) {
      errors.push(toError(error));
    }
    if (!(await waitForExit(state, this.stopTimeoutMilliseconds))) {
      try {
        state.child.kill("SIGKILL");
      } catch (error) {
        errors.push(toError(error));
      }
      if (!(await waitForExit(state, this.stopTimeoutMilliseconds))) {
        errors.push(
          new Error("Native macOS capture helper did not exit after SIGKILL."),
        );
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "Native macOS capture helper cleanup failed.",
      );
    }
  }
}

function nativeCaptureArguments(options: CaptureSourceStartOptions): string[] {
  const arguments_: string[] = [];
  if (options.preferredInputDevice !== null) {
    arguments_.push(
      "--preferred-input-device",
      options.preferredInputDevice,
    );
  }
  if (options.enforcePreferredInputDevice) {
    arguments_.push("--enforce-preferred-input-device");
  }
  return arguments_;
}

function spawnNativeCaptureProcess(
  binaryPath: string,
  arguments_: string[],
): NativeMacCaptureChildProcess {
  return spawn(binaryPath, arguments_, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForExit(
  state: NativeCaptureState,
  timeoutMilliseconds: number,
): Promise<boolean> {
  if (state.exitSettled) {
    return true;
  }
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      state.exitDeferred.promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}

function formatExit(
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  if (code !== null) {
    return `with code ${code}`;
  }
  if (signal !== null) {
    return `from signal ${signal}`;
  }
  return "without an exit code";
}

function formatStderr(stderr: Buffer): string {
  const context = stderr.toString("utf8").trim();
  return context.length === 0 ? "" : `; stderr: ${context}`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
