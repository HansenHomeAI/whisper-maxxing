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
const MAXIMUM_DRAIN_FALLBACK_MILLISECONDS = 100;
const MAXIMUM_STDERR_CONTEXT_BYTES = 8_192;

interface NativeMacCaptureChildProcess {
  readonly pid?: number | undefined;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "exit" | "close",
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
  finalizedDeferred: Deferred<void>;
  startSettled: boolean;
  exitObserved: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  stdoutDrained: boolean;
  childClosed: boolean;
  finalized: boolean;
  cleanupStarted: boolean;
  cleanupRequiresStopped: boolean;
  cleanupPromise: Promise<void> | null;
  failurePromise: Promise<void> | null;
  protocolError: Error | null;
  drainFallback: ReturnType<typeof setTimeout> | null;
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
  private readonly drainFallbackMilliseconds: number;
  private readonly usesInjectedSpawner: boolean;
  private readonly now: () => number;
  private active: NativeCaptureState | null = null;
  private commandTail: Promise<void> = Promise.resolve();
  private queuedCommandCount = 0;
  private commandGeneration = 0;

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
    this.usesInjectedSpawner = options.spawnProcess !== undefined;
    this.spawnProcess = options.spawnProcess ?? spawnNativeCaptureProcess;
    this.stopTimeoutMilliseconds = stopTimeoutMilliseconds;
    this.drainFallbackMilliseconds = Math.min(
      stopTimeoutMilliseconds,
      MAXIMUM_DRAIN_FALLBACK_MILLISECONDS,
    );
    this.now = options.now ?? (() => performance.now());
  }

  get childProcessId(): number | null {
    return this.active?.child.pid ?? null;
  }

  start(options: CaptureSourceStartOptions): Promise<CaptureSourceInfo> {
    const generation = ++this.commandGeneration;
    if (this.active === null && this.queuedCommandCount === 0) {
      return this.startNow(options);
    }

    const result = deferred<CaptureSourceInfo>();
    void this.enqueueCommand(async () => {
      if (generation !== this.commandGeneration) {
        result.reject(supersededStartError());
        return;
      }
      try {
        await this.stopActive(
          new Error("Native macOS capture was replaced by a newer start."),
        );
      } catch (error) {
        result.reject(toError(error));
        return;
      }
      if (generation !== this.commandGeneration) {
        result.reject(supersededStartError());
        return;
      }
      this.startNow(options).then(result.resolve, result.reject);
    });
    return result.promise;
  }

  stop(): Promise<void> {
    ++this.commandGeneration;
    const cancellation = new Error(
      "Native macOS capture stopped during startup.",
    );
    if (this.queuedCommandCount === 0) {
      return this.stopActive(cancellation);
    }
    return this.enqueueCommand(async () => {
      await this.stopActive(cancellation);
    });
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
      finalizedDeferred: deferred<void>(),
      startSettled: false,
      exitObserved: false,
      exitCode: null,
      exitSignal: null,
      stdoutDrained: false,
      childClosed: false,
      finalized: false,
      cleanupStarted: false,
      cleanupRequiresStopped: false,
      cleanupPromise: null,
      failurePromise: null,
      protocolError: null,
      drainFallback: null,
      stderrContext: Buffer.alloc(0),
    };
    this.active = state;

    child.stdout.on("data", (chunk: Buffer | string) => {
      this.handleStdout(state, chunk);
    });
    child.stdout.once("end", () => {
      this.handleStdoutDrained(state);
    });
    child.stdout.once("close", () => {
      this.handleStdoutDrained(state);
    });
    child.stdout.once("error", (error) => {
      this.handleProtocolFailure(
        state,
        new Error(
          `Native macOS capture stdout failed: ${toError(error).message}`,
          { cause: error },
        ),
      );
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
    child.once("close", (code, signal) => {
      this.handleClose(state, code, signal);
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
    if (state.finalized || state.protocolError !== null) {
      return;
    }
    let messages: NativeMacCaptureMessage[];
    try {
      messages = state.parser.push(
        typeof chunk === "string" ? Buffer.from(chunk) : chunk,
      );
    } catch (error) {
      this.handleProtocolFailure(
        state,
        new Error(
          `Native macOS capture protocol error: ${toError(error).message}`,
          { cause: error },
        ),
      );
      return;
    }

    for (const message of messages) {
      this.handleMessage(state, message);
    }
  }

  private handleMessage(
    state: NativeCaptureState,
    message: NativeMacCaptureMessage,
  ): void {
    if (state.failurePromise !== null && message.type !== "stopped") {
      return;
    }
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
          this.beginFailure(
            state,
            new Error(
              `Native macOS capture frame consumer failed: ${toError(error).message}`,
              { cause: error },
            ),
            true,
          );
        }
        return;
      }
      case "error":
        this.beginFailure(
          state,
          new Error(`Native macOS capture helper error: ${message.message}`),
          true,
        );
        return;
      case "stopped":
        if (!state.cleanupStarted) {
          this.beginFailure(
            state,
            new Error("Native macOS capture helper stopped unexpectedly."),
            true,
          );
        }
        return;
    }
  }

  private handleProtocolFailure(
    state: NativeCaptureState,
    error: Error,
  ): void {
    if (state.protocolError !== null) {
      return;
    }
    state.protocolError = error;
    this.beginFailure(state, error, false);
  }

  private handleStderr(
    state: NativeCaptureState,
    chunk: Buffer | string,
  ): void {
    if (state.finalized) {
      return;
    }
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    state.stderrContext = Buffer.concat([state.stderrContext, bytes]).subarray(
      -MAXIMUM_STDERR_CONTEXT_BYTES,
    );
  }

  private handleProcessError(state: NativeCaptureState, error: Error): void {
    if (state.finalized) {
      return;
    }
    if (state.child.pid === undefined) {
      this.observeExit(state, state.child.exitCode, state.child.signalCode);
    }
    this.beginFailure(
      state,
      new Error(
        `Native macOS capture helper process failed: ${error.message}`,
        { cause: error },
      ),
      false,
    );
  }

  private handleExit(
    state: NativeCaptureState,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    this.observeExit(state, code, signal);
  }

  private handleClose(
    state: NativeCaptureState,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    state.childClosed = true;
    this.observeExit(state, code, signal);
    this.finalizeState(state);
  }

  private observeExit(
    state: NativeCaptureState,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (!state.exitObserved) {
      state.exitObserved = true;
      state.exitCode = code;
      state.exitSignal = signal;
      state.exitDeferred.resolve();
      if (this.usesInjectedSpawner) {
        state.drainFallback = setTimeout(() => {
          this.finalizeState(state);
        }, this.drainFallbackMilliseconds);
      }
      void state.finalizedDeferred.promise.then(() => {
        if (!state.cleanupStarted && state.failurePromise === null) {
          this.beginFailure(
            state,
            new Error(
              `Native macOS capture helper exited unexpectedly ${formatExit(state.exitCode, state.exitSignal)}${formatStderr(state.stderrContext)}.`,
            ),
            true,
          );
        }
      });
    }
    if (state.stdoutDrained || state.childClosed) {
      this.finalizeState(state);
    }
  }

  private handleStdoutDrained(state: NativeCaptureState): void {
    state.stdoutDrained = true;
    if (state.exitObserved) {
      this.finalizeState(state);
    }
  }

  private finalizeState(state: NativeCaptureState): void {
    if (state.finalized || !state.exitObserved) {
      return;
    }
    if (state.drainFallback !== null) {
      clearTimeout(state.drainFallback);
      state.drainFallback = null;
    }
    if (state.protocolError === null) {
      try {
        state.parser.finish();
      } catch (error) {
        state.protocolError = new Error(
          `Native macOS capture protocol error: ${toError(error).message}`,
          { cause: error },
        );
      }
    }
    state.finalized = true;
    state.finalizedDeferred.resolve();
    if (this.active === state) {
      this.active = null;
    }
  }

  private beginFailure(
    state: NativeCaptureState,
    error: Error,
    requireStopped: boolean,
  ): void {
    if (state.failurePromise !== null) {
      state.cleanupRequiresStopped ||= requireStopped;
      return;
    }
    const completion = deferred<void>();
    state.failurePromise = completion.promise;
    void (async () => {
      let surfacedError = error;
      try {
        await this.cleanupState(state, requireStopped);
      } catch (cleanupError) {
        surfacedError = combineErrors(
          error,
          toError(cleanupError),
          "Native macOS capture failed and cleanup did not complete cleanly.",
        );
      }
      this.rejectStart(state, surfacedError);
      state.startOptions.onError(surfacedError);
    })().then(completion.resolve, completion.reject);
  }

  private stopActive(cancellation: Error): Promise<void> {
    const state = this.active;
    if (state === null) {
      return Promise.resolve();
    }
    const stopping = this.cleanupState(state, true);
    return stopping.then(
      () => {
        this.rejectStart(state, cancellation);
      },
      (cleanupError: unknown) => {
        const cleanup = toError(cleanupError);
        if (!state.startSettled) {
          this.rejectStart(
            state,
            combineErrors(
              cancellation,
              cleanup,
              "Native macOS capture cancellation and cleanup both failed.",
            ),
          );
        }
        throw cleanup;
      },
    );
  }

  private cleanupState(
    state: NativeCaptureState,
    requireStopped: boolean,
  ): Promise<void> {
    state.cleanupStarted = true;
    state.cleanupRequiresStopped ||= requireStopped;
    if (state.cleanupPromise !== null) {
      return state.cleanupPromise;
    }
    const completion = deferred<void>();
    state.cleanupPromise = completion.promise;
    void this.runCleanup(state).then(completion.resolve, completion.reject);
    return completion.promise;
  }

  private async runCleanup(state: NativeCaptureState): Promise<void> {
    const errors: Error[] = [];
    if (!state.exitObserved) {
      try {
        state.child.kill("SIGTERM");
      } catch (error) {
        errors.push(toError(error));
      }
    }
    if (
      !state.exitObserved &&
      !(await waitFor(state.exitDeferred.promise, this.stopTimeoutMilliseconds))
    ) {
      try {
        state.child.kill("SIGKILL");
      } catch (error) {
        errors.push(toError(error));
      }
      if (
        !(await waitFor(
          state.exitDeferred.promise,
          this.stopTimeoutMilliseconds,
        ))
      ) {
        errors.push(
          new Error(
            "Native macOS capture helper did not exit after SIGKILL and remains tracked.",
          ),
        );
      }
    }

    if (state.exitObserved) {
      await waitFor(
        state.finalizedDeferred.promise,
        this.usesInjectedSpawner
          ? this.drainFallbackMilliseconds + 10
          : this.stopTimeoutMilliseconds,
      );
      if (!state.finalized) {
        errors.push(
          new Error("Native macOS capture stdout did not finish draining."),
        );
      }
    }
    if (state.protocolError !== null) {
      errors.push(state.protocolError);
    }
    if (
      state.cleanupRequiresStopped &&
      !state.parser.hasReceivedStopped
    ) {
      errors.push(
        new Error(
          "Native macOS capture helper exited without a valid stopped frame.",
        ),
      );
    }
    throwCollectedErrors(
      errors,
      "Native macOS capture helper cleanup failed.",
    );
  }

  private rejectStart(state: NativeCaptureState, error: Error): void {
    if (!state.startSettled) {
      state.startSettled = true;
      state.startDeferred.reject(error);
    }
  }

  private enqueueCommand<T>(operation: () => Promise<T>): Promise<T> {
    this.queuedCommandCount += 1;
    const result = this.commandTail.then(operation);
    this.commandTail = result.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      this.queuedCommandCount -= 1;
    });
    return result;
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

async function waitFor(
  promise: Promise<void>,
  timeoutMilliseconds: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.then(() => true),
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

function supersededStartError(): Error {
  return new Error("Native macOS capture start was superseded.");
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

function combineErrors(
  primary: Error,
  secondary: Error,
  message: string,
): Error {
  if (primary === secondary) {
    return primary;
  }
  return new AggregateError(
    [primary, secondary],
    `${message} ${primary.message} Cleanup: ${secondary.message}`,
  );
}

function throwCollectedErrors(errors: Error[], message: string): void {
  const unique = errors.filter(
    (error, index) => errors.indexOf(error) === index,
  );
  if (unique.length === 1) {
    throw unique[0];
  }
  if (unique.length > 1) {
    throw new AggregateError(
      unique,
      `${message} ${unique.map((error) => error.message).join(" ")}`,
    );
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
