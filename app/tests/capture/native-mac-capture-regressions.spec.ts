import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type {
  CapturedAudioFrame,
  CaptureSourceStartOptions,
} from "../../src/main/capture/captureSource.js";
import {
  resolveNativeMacCaptureBinary,
} from "../../src/main/capture/captureSourceFactory.js";
import {
  NativeMacCaptureMessageType,
  NativeMacCaptureProtocolParser,
  encodeNativeMacCaptureFrame,
} from "../../src/main/capture/nativeMacCaptureProtocol.js";
import { NativeMacCaptureSource } from "../../src/main/capture/nativeMacCaptureSource.js";

describe("native macOS capture regressions", () => {
  it("rejects stopped before ready and empty PCM transport frames", () => {
    expect(() => new NativeMacCaptureProtocolParser().push(stoppedFrame()))
      .toThrow("before ready");

    const parser = new NativeMacCaptureProtocolParser();
    parser.push(readyFrame());
    expect(() => parser.push(encodeNativeMacCaptureFrame(
      NativeMacCaptureMessageType.Pcm,
      Buffer.alloc(0),
    ))).toThrow("must not be empty");
  });

  it("accepts compact nonempty even PCM transport frames", () => {
    const parser = new NativeMacCaptureProtocolParser();
    parser.push(readyFrame());
    const messages = parser.push(encodeNativeMacCaptureFrame(
      NativeMacCaptureMessageType.Pcm,
      Buffer.from([7, 0]),
    ));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "pcm" });
  });

  it("fails startup and reaps a helper that stops before ready", async () => {
    const child = new FakeChild((_signal, process) => {
      process.finish(74, null);
    });
    const onError = vi.fn();
    const source = sourceFor([child]);
    const started = source.start(startOptions({ onError }));

    child.stdout.write(stoppedFrame());

    await expect(started).rejects.toThrow("stopped before ready");
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(source.childProcessId).toBeNull();
  });

  it("reaps the helper before surfacing protocol failure", async () => {
    const child = new FakeChild((_signal, process) => {
      process.finish(70, null);
    });
    const onError = vi.fn();
    const source = sourceFor([child]);
    const started = source.start(startOptions({ onError }));
    child.stdout.write(readyFrame());
    await started;

    child.stdout.write(Buffer.from([99, 0, 0, 0, 0]));

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(source.childProcessId).toBeNull();
    expect(onError.mock.calls[0]![0].message).toContain("protocol error");
  });

  it("escalates failure cleanup to SIGKILL and reaps the helper", async () => {
    const child = new FakeChild((signal, process) => {
      if (signal === "SIGKILL") {
        process.finish(null, "SIGKILL");
      }
    });
    const onError = vi.fn();
    const source = sourceFor([child]);
    const started = source.start(startOptions({ onError }));
    child.stdout.write(readyFrame());
    await started;

    child.stdout.write(Buffer.from([99, 0, 0, 0, 0]));

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(source.childProcessId).toBeNull();
  });

  it("surfaces when failure cleanup cannot reap the tracked helper", async () => {
    const child = new FakeChild();
    const onError = vi.fn();
    const source = sourceFor([child]);
    const started = source.start(startOptions({ onError }));
    child.stdout.write(readyFrame());
    await started;

    child.stdout.write(errorFrame("device disconnected"));

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(onError.mock.calls[0]![0].message).toContain("remains tracked");
    expect(source.childProcessId).toBe(child.pid);
    child.finish(73, null);
  });

  it("surfaces helper failure together with missing stopped cleanup", async () => {
    const child = new FakeChild((_signal, process) => {
      process.finish(72, null);
    });
    const onError = vi.fn();
    const source = sourceFor([child]);
    const started = source.start(startOptions({ onError }));
    child.stdout.write(readyFrame());
    await started;

    child.stdout.write(errorFrame("device disconnected"));

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    const message = onError.mock.calls[0]![0].message;
    expect(message).toContain("device disconnected");
    expect(message).toContain("without a valid stopped frame");
    expect(source.childProcessId).toBeNull();
  });

  it("reaps the helper when the frame consumer fails", async () => {
    const child = gracefulChild();
    const onError = vi.fn();
    const source = sourceFor([child]);
    const started = source.start(startOptions({
      onFrame: () => {
        throw new Error("frame sink unavailable");
      },
      onError,
    }));
    child.stdout.write(readyFrame());
    await started;

    child.stdout.write(pcmFrame([1]));

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]![0].message).toContain(
      "frame sink unavailable",
    );
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(source.childProcessId).toBeNull();
  });

  it("drains stdout after exit before finalizing the helper", async () => {
    const child = new FakeChild();
    const onFrame = vi.fn();
    const onError = vi.fn();
    const source = sourceFor([child]);
    const started = source.start(startOptions({ onFrame, onError }));
    child.stdout.write(readyFrame());
    await started;

    child.emitExit(0, null);
    expect(onError).not.toHaveBeenCalled();
    child.stdout.write(pcmFrame([9, -9]));
    child.stdout.write(stoppedFrame());
    child.drainAndClose(0, null);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect([...onFrame.mock.calls[0]![0].samples]).toEqual([9, -9]);
    expect(onError.mock.calls[0]![0].message).toContain("unexpectedly");
  });

  it("rejects graceful cleanup that omits stopped", async () => {
    const child = new FakeChild((_signal, process) => {
      process.finish(0, null);
    });
    const source = sourceFor([child]);
    const started = source.start(startOptions());
    child.stdout.write(readyFrame());
    await started;

    await expect(source.stop()).rejects.toThrow("without a valid stopped frame");
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(source.childProcessId).toBeNull();
  });

  it("rejects malformed stopped during graceful cleanup", async () => {
    const child = new FakeChild((_signal, process) => {
      process.stdout.write(encodeNativeMacCaptureFrame(
        NativeMacCaptureMessageType.Stopped,
        Buffer.from([1]),
      ));
      process.finish(0, null);
    });
    const onError = vi.fn();
    const source = sourceFor([child]);
    const started = source.start(startOptions({ onError }));
    child.stdout.write(readyFrame());
    await started;

    await expect(source.stop()).rejects.toThrow("stopped frame");
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("allows only the newest queued start to spawn", async () => {
    const first = gracefulChild();
    const second = gracefulChild();
    const children = [first, second];
    const source = sourceFor(children);
    const firstStarted = source.start(startOptions());
    first.stdout.write(readyFrame("First"));
    await firstStarted;

    const superseded = source.start(startOptions());
    const newest = source.start(startOptions());
    await expect(superseded).rejects.toThrow("superseded");
    await vi.waitFor(() => expect(children).toHaveLength(0));
    second.stdout.write(readyFrame("Second"));
    await expect(newest).resolves.toEqual({
      defaultInputDeviceName: "Second",
    });
    expect(first.signals).toEqual(["SIGTERM"]);
    expect(second.signals).toEqual([]);

    const stopped = source.stop();
    await expect(stopped).resolves.toBeUndefined();
  });

  it("stop cancels every queued start without spawning another helper", async () => {
    const first = gracefulChild();
    const children = [first];
    const source = sourceFor(children);
    const firstStarted = source.start(startOptions());
    first.stdout.write(readyFrame());
    await firstStarted;

    const queuedOne = source.start(startOptions());
    const queuedTwo = source.start(startOptions());
    const stopped = source.stop();

    await expect(queuedOne).rejects.toThrow("superseded");
    await expect(queuedTwo).rejects.toThrow("superseded");
    await expect(stopped).resolves.toBeUndefined();
    expect(children).toHaveLength(0);
    expect(first.signals).toEqual(["SIGTERM"]);
    expect(source.childProcessId).toBeNull();
  });

  it("requires deterministic appRoot for development helper resolution", () => {
    expect(() => resolveNativeMacCaptureBinary({
      isPackaged: false,
      resourcesPath: "/resources",
    })).toThrow("explicit appRoot");
    expect(resolveNativeMacCaptureBinary({
      isPackaged: false,
      resourcesPath: "/resources",
      appRoot: "/repo/app",
    })).toBe(resolve(
      "/repo/app",
      "native/macos-capture/.build/release/whisper-mac-capture",
    ));
  });
});

function sourceFor(children: FakeChild[]): NativeMacCaptureSource {
  return new NativeMacCaptureSource({
    binaryPath: "/fake/whisper-mac-capture",
    spawnProcess: () => {
      const child = children.shift();
      if (child === undefined) {
        throw new Error("Unexpected helper spawn");
      }
      return child.asSpawnedProcess();
    },
    stopTimeoutMilliseconds: 20,
  });
}

function startOptions(overrides: {
  onFrame?: (frame: CapturedAudioFrame) => void;
  onError?: (error: Error) => void;
} = {}): CaptureSourceStartOptions {
  return {
    preferredInputDevice: null,
    enforcePreferredInputDevice: false,
    onFrame: overrides.onFrame ?? vi.fn(),
    onError: overrides.onError ?? vi.fn(),
  };
}

function gracefulChild(): FakeChild {
  return new FakeChild((_signal, process) => {
    process.stdout.write(stoppedFrame());
    process.finish(0, null);
  });
}

function readyFrame(defaultInputDeviceName: string | null = null): Buffer {
  return encodeNativeMacCaptureFrame(
    NativeMacCaptureMessageType.Ready,
    Buffer.from(JSON.stringify({
      protocolVersion: 1,
      sampleRateHz: 16_000,
      channels: 1,
      sampleFormat: "s16le",
      defaultInputDeviceName,
    })),
  );
}

function pcmFrame(samples: number[]): Buffer {
  const payload = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => payload.writeInt16LE(sample, index * 2));
  return encodeNativeMacCaptureFrame(
    NativeMacCaptureMessageType.Pcm,
    payload,
  );
}

function errorFrame(message: string): Buffer {
  return encodeNativeMacCaptureFrame(
    NativeMacCaptureMessageType.Error,
    Buffer.from(JSON.stringify({ message })),
  );
}

function stoppedFrame(): Buffer {
  return encodeNativeMacCaptureFrame(
    NativeMacCaptureMessageType.Stopped,
    Buffer.alloc(0),
  );
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 42_424;
  readonly signals: NodeJS.Signals[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(
    private readonly onKill?: (
      signal: NodeJS.Signals,
      process: FakeChild,
    ) => void,
  ) {
    super();
  }

  asSpawnedProcess(): never {
    return this as never;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    this.onKill?.(signal, this);
    return true;
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  drainAndClose(code: number | null, signal: NodeJS.Signals | null): void {
    this.stdout.end();
    this.emit("close", code, signal);
  }

  finish(code: number | null, signal: NodeJS.Signals | null): void {
    this.emitExit(code, signal);
    this.drainAndClose(code, signal);
  }
}
