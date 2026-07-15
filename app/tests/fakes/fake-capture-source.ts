import { readFileSync } from "node:fs";

import type {
  CaptureClock,
  CaptureSource,
  CaptureSourceInfo,
  CaptureSourceStartOptions,
} from "../../src/main/capture/captureSource.js";

export class FakeCaptureClock implements CaptureClock {
  constructor(private currentMilliseconds = 0) {}

  now(): number {
    return this.currentMilliseconds;
  }

  advance(milliseconds: number): void {
    this.currentMilliseconds += milliseconds;
  }
}

export interface FakeCaptureSourceOptions {
  wavPath: string;
  clock: CaptureClock;
  frameSamples?: number;
  availableInputDevices?: string[];
  defaultInputDeviceName?: string;
}

export class FakeCaptureSource implements CaptureSource {
  readonly samples: Int16Array;
  readonly sampleRate: number;
  startCallCount = 0;
  stopCallCount = 0;
  private readonly clock: CaptureClock;
  private readonly frameSamples: number;
  private readonly availableInputDevices: string[];
  private readonly configuredDefaultInputDeviceName: string;
  private startFailures: Error[] = [];
  private startOptions: CaptureSourceStartOptions | null = null;
  private sampleOffset = 0;

  constructor(options: FakeCaptureSourceOptions) {
    const wav = parseMonoPcm16Wav(readFileSync(options.wavPath));
    this.samples = wav.samples;
    this.sampleRate = wav.sampleRate;
    this.clock = options.clock;
    this.frameSamples = options.frameSamples ?? 1_600;
    this.availableInputDevices = options.availableInputDevices ?? ["Fake Microphone"];
    this.configuredDefaultInputDeviceName =
      options.defaultInputDeviceName ?? this.availableInputDevices[0] ?? "Fake Microphone";
  }

  async start(
    options: CaptureSourceStartOptions,
  ): Promise<CaptureSourceInfo> {
    this.startCallCount += 1;
    const failure = this.startFailures.shift();
    if (failure !== undefined) {
      throw failure;
    }
    const preferredAvailable =
      options.preferredInputDevice === null ||
      this.availableInputDevices.includes(options.preferredInputDevice);
    if (!preferredAvailable && options.enforcePreferredInputDevice) {
      throw new Error(
        `Preferred audio input device not found: ${options.preferredInputDevice}`,
      );
    }
    this.startOptions = options;
    return {
      defaultInputDeviceName:
        options.preferredInputDevice !== null && preferredAvailable
          ? options.preferredInputDevice
          : this.configuredDefaultInputDeviceName,
    };
  }

  async stop(): Promise<void> {
    this.stopCallCount += 1;
    this.startOptions = null;
  }

  queueStartFailures(...failures: Error[]): void {
    this.startFailures.push(...failures);
  }

  emitNextFrame(): Int16Array {
    if (this.startOptions === null) {
      throw new Error("Fake capture source is not started.");
    }
    if (this.sampleOffset >= this.samples.length) {
      throw new Error("Fake capture fixture is exhausted.");
    }
    const end = Math.min(this.sampleOffset + this.frameSamples, this.samples.length);
    const frame = this.samples.slice(this.sampleOffset, end);
    this.sampleOffset = end;
    this.startOptions.onFrame({
      samples: frame,
      timestampMilliseconds: this.clock.now(),
    });
    return frame;
  }

  emitFrames(count: number): Int16Array {
    const emitted: number[] = [];
    for (let index = 0; index < count; index += 1) {
      emitted.push(...this.emitNextFrame());
    }
    return Int16Array.from(emitted);
  }

  failStream(message: string): void {
    if (this.startOptions === null) {
      throw new Error("Fake capture source is not started.");
    }
    this.startOptions.onError(new Error(message));
  }

  rewind(): void {
    this.sampleOffset = 0;
  }
}

export interface ParsedWav {
  sampleRate: number;
  samples: Int16Array;
}

export function parseMonoPcm16Wav(data: Uint8Array): ParsedWav {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (ascii(data, 0, 4) !== "RIFF" || ascii(data, 8, 4) !== "WAVE") {
    throw new Error("Audio fixture is not a RIFF/WAVE file.");
  }

  let offset = 12;
  let format: {
    encoding: number;
    channels: number;
    sampleRate: number;
    bitsPerSample: number;
  } | null = null;
  let pcmOffset: number | null = null;
  let pcmLength = 0;
  while (offset + 8 <= data.byteLength) {
    const chunk = ascii(data, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const bodyOffset = offset + 8;
    if (bodyOffset + length > data.byteLength) {
      throw new Error(`Invalid WAV ${chunk} chunk length.`);
    }
    if (chunk === "fmt ") {
      format = {
        encoding: view.getUint16(bodyOffset, true),
        channels: view.getUint16(bodyOffset + 2, true),
        sampleRate: view.getUint32(bodyOffset + 4, true),
        bitsPerSample: view.getUint16(bodyOffset + 14, true),
      };
    } else if (chunk === "data") {
      pcmOffset = bodyOffset;
      pcmLength = length;
    }
    offset = bodyOffset + length + (length % 2);
  }

  if (format === null || pcmOffset === null) {
    throw new Error("Audio fixture is missing fmt or data chunks.");
  }
  if (
    format.encoding !== 1 ||
    format.channels !== 1 ||
    format.bitsPerSample !== 16
  ) {
    throw new Error("Audio fixture must be mono 16-bit PCM.");
  }
  const samples = new Int16Array(pcmLength / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(pcmOffset + index * 2, true);
  }
  return { sampleRate: format.sampleRate, samples };
}

function ascii(data: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...data.subarray(offset, offset + length));
}
