import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  MAXIMUM_NATIVE_CAPTURE_PAYLOAD_BYTES,
  NativeMacCaptureMessageType,
  NativeMacCaptureProtocolParser,
  encodeNativeMacCaptureFrame,
} from "../../../src/main/capture/nativeMacCaptureProtocol.js";
import { NativeMacCaptureSource } from "../../../src/main/capture/nativeMacCaptureSource.js";
import { selectCaptureBackend } from "../../../src/main/capture/captureSourceFactory.js";

describe("native macOS capture acceptance", () => {
  it("selects native only for Darwin unless explicitly disabled", () => {
    expect(selectCaptureBackend("darwin", "native")).toBe("native-macos");
    expect(selectCaptureBackend("darwin", "electron")).toBe("electron-renderer");
    expect(selectCaptureBackend("win32", "native")).toBe("electron-renderer");
    expect(selectCaptureBackend("win32", "electron")).toBe("electron-renderer");
    expect(selectCaptureBackend("linux", "native")).toBe("electron-renderer");
  });

  it("parses arbitrarily fragmented and coalesced frames", () => {
    const parser = new NativeMacCaptureProtocolParser();
    const ready = encodeNativeMacCaptureFrame(
      NativeMacCaptureMessageType.Ready,
      Buffer.from(JSON.stringify({
        protocolVersion: 1,
        sampleRateHz: 16_000,
        channels: 1,
        sampleFormat: "s16le",
        defaultInputDeviceName: "Built-in Microphone",
      })),
    );
    const pcm = encodeNativeMacCaptureFrame(
      NativeMacCaptureMessageType.Pcm,
      Buffer.from([1, 0, 254, 255, 255, 127, 0, 128]),
    );
    const stopped = encodeNativeMacCaptureFrame(
      NativeMacCaptureMessageType.Stopped,
      Buffer.alloc(0),
    );
    const stream = Buffer.concat([ready, pcm, stopped]);
    const messages = [
      ...parser.push(stream.subarray(0, 2)),
      ...parser.push(stream.subarray(2, 9)),
      ...parser.push(stream.subarray(9, ready.length + 3)),
      ...parser.push(stream.subarray(ready.length + 3)),
    ];

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      type: "ready",
      defaultInputDeviceName: "Built-in Microphone",
    });
    expect(messages[1]).toMatchObject({ type: "pcm" });
    if (messages[1]?.type !== "pcm") {
      throw new Error("Expected PCM frame");
    }
    expect([...messages[1].samples]).toEqual([1, -2, 32_767, -32_768]);
    expect(messages[2]).toEqual({ type: "stopped" });
  });

  it("rejects oversized, unknown, malformed ready, odd PCM, and stopped payloads", () => {
    const cases: Buffer[] = [];
    const oversized = Buffer.alloc(5);
    oversized[0] = NativeMacCaptureMessageType.Pcm;
    oversized.writeUInt32LE(MAXIMUM_NATIVE_CAPTURE_PAYLOAD_BYTES + 1, 1);
    cases.push(oversized);
    cases.push(Buffer.from([99, 0, 0, 0, 0]));
    cases.push(encodeNativeMacCaptureFrame(
      NativeMacCaptureMessageType.Ready,
      Buffer.from("{}"),
    ));
    cases.push(encodeNativeMacCaptureFrame(
      NativeMacCaptureMessageType.Pcm,
      Buffer.from([1]),
    ));
    cases.push(encodeNativeMacCaptureFrame(
      NativeMacCaptureMessageType.Stopped,
      Buffer.from([1]),
    ));

    for (const data of cases) {
      const parser = new NativeMacCaptureProtocolParser();
      expect(() => parser.push(data)).toThrow();
    }
  });

  it("streams frames and terminates the helper without leaking it", async () => {
    const child = new FakeChild();
    const onFrame = vi.fn();
    const onError = vi.fn();
    const source = new NativeMacCaptureSource({
      binaryPath: "/fake/whisper-mac-capture",
      spawnProcess: (_binary, arguments_) => {
        child.spawnArguments = arguments_;
        return child.asSpawnedProcess();
      },
      stopTimeoutMilliseconds: 50,
    });

    const started = source.start({
      preferredInputDevice: "MacBook Pro Microphone",
      enforcePreferredInputDevice: true,
      onFrame,
      onError,
    });
    expect(child.spawnArguments).toEqual([
      "--preferred-input-device",
      "MacBook Pro Microphone",
      "--enforce-preferred-input-device",
    ]);
    child.stdout.write(readyFrame("MacBook Pro Microphone"));
    await expect(started).resolves.toEqual({
      defaultInputDeviceName: "MacBook Pro Microphone",
    });
    child.stdout.write(encodeNativeMacCaptureFrame(
      NativeMacCaptureMessageType.Pcm,
      Buffer.from([42, 0, 214, 255]),
    ));
    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledTimes(1));
    expect([...onFrame.mock.calls[0]![0].samples]).toEqual([42, -42]);

    const stopped = source.stop();
    expect(child.signals).toEqual(["SIGTERM"]);
    child.stdout.write(encodeNativeMacCaptureFrame(
      NativeMacCaptureMessageType.Stopped,
      Buffer.alloc(0),
    ));
    child.exit(0, null);
    await expect(stopped).resolves.toBeUndefined();
    expect(source.childProcessId).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it("surfaces unexpected exits instead of starting another backend", async () => {
    const child = new FakeChild();
    const onError = vi.fn();
    const source = new NativeMacCaptureSource({
      binaryPath: "/fake/whisper-mac-capture",
      spawnProcess: (_binary, arguments_) => {
        child.spawnArguments = arguments_;
        return child.asSpawnedProcess();
      },
      stopTimeoutMilliseconds: 10,
    });
    const started = source.start({
      preferredInputDevice: null,
      enforcePreferredInputDevice: false,
      onFrame: vi.fn(),
      onError,
    });
    child.stdout.write(readyFrame(null));
    await started;
    child.exit(71, null);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]![0].message).toContain("71");
  });
});

function readyFrame(defaultInputDeviceName: string | null): Buffer {
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

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 42_424;
  readonly signals: string[] = [];
  spawnArguments: string[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  asSpawnedProcess(): never {
    return this as never;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}
