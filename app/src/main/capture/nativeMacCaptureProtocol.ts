export const NATIVE_MAC_CAPTURE_PROTOCOL_VERSION = 1;
export const MAXIMUM_NATIVE_CAPTURE_PAYLOAD_BYTES = 262_144;

const NATIVE_MAC_CAPTURE_HEADER_BYTES = 5;
const NATIVE_MAC_CAPTURE_SAMPLE_RATE_HZ = 16_000;
const NATIVE_MAC_CAPTURE_CHANNELS = 1;
const NATIVE_MAC_CAPTURE_SAMPLE_FORMAT = "s16le";

export enum NativeMacCaptureMessageType {
  Ready = 1,
  Pcm = 2,
  Error = 3,
  Stopped = 4,
}

export interface NativeMacCaptureReadyMessage {
  type: "ready";
  protocolVersion: 1;
  sampleRateHz: 16_000;
  channels: 1;
  sampleFormat: "s16le";
  defaultInputDeviceName: string | null;
}

export interface NativeMacCapturePcmMessage {
  type: "pcm";
  samples: Int16Array;
}

export interface NativeMacCaptureErrorMessage {
  type: "error";
  message: string;
}

export interface NativeMacCaptureStoppedMessage {
  type: "stopped";
}

export type NativeMacCaptureMessage =
  | NativeMacCaptureReadyMessage
  | NativeMacCapturePcmMessage
  | NativeMacCaptureErrorMessage
  | NativeMacCaptureStoppedMessage;

export class NativeMacCaptureProtocolParser {
  private buffered = Buffer.alloc(0);
  private readyReceived = false;
  private stoppedReceived = false;
  private failure: Error | null = null;

  get hasReceivedReady(): boolean {
    return this.readyReceived;
  }

  get hasReceivedStopped(): boolean {
    return this.stoppedReceived;
  }

  push(chunk: Uint8Array): NativeMacCaptureMessage[] {
    if (this.failure !== null) {
      throw this.failure;
    }
    if (chunk.byteLength === 0) {
      return [];
    }
    if (this.stoppedReceived) {
      this.failure = new Error(
        "Native capture protocol received bytes after stopped.",
      );
      throw this.failure;
    }

    try {
      this.buffered = Buffer.concat([
        this.buffered,
        Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      ]);
      return this.parseAvailableFrames();
    } catch (error) {
      this.failure = toError(error);
      throw this.failure;
    }
  }

  finish(): void {
    if (this.failure !== null) {
      throw this.failure;
    }
    if (this.buffered.byteLength !== 0) {
      this.failure = new Error(
        `Native capture stream ended with ${this.buffered.byteLength} incomplete frame bytes.`,
      );
      throw this.failure;
    }
  }

  private parseAvailableFrames(): NativeMacCaptureMessage[] {
    const messages: NativeMacCaptureMessage[] = [];
    while (this.buffered.byteLength >= NATIVE_MAC_CAPTURE_HEADER_BYTES) {
      if (this.stoppedReceived) {
        throw new Error("Native capture protocol received a frame after stopped.");
      }

      const rawType = this.buffered[0];
      if (!isNativeMacCaptureMessageType(rawType)) {
        throw new Error(`Unknown native capture message type: ${String(rawType)}.`);
      }
      const payloadLength = this.buffered.readUInt32LE(1);
      if (payloadLength > MAXIMUM_NATIVE_CAPTURE_PAYLOAD_BYTES) {
        throw new Error(
          `Native capture payload is ${payloadLength} bytes; maximum is ${MAXIMUM_NATIVE_CAPTURE_PAYLOAD_BYTES}.`,
        );
      }

      const frameLength = NATIVE_MAC_CAPTURE_HEADER_BYTES + payloadLength;
      if (this.buffered.byteLength < frameLength) {
        break;
      }
      const payload = this.buffered.subarray(
        NATIVE_MAC_CAPTURE_HEADER_BYTES,
        frameLength,
      );
      this.buffered = this.buffered.subarray(frameLength);
      messages.push(this.decodeFrame(rawType, payload));
      if (this.stoppedReceived && this.buffered.byteLength !== 0) {
        throw new Error("Native capture protocol received bytes after stopped.");
      }
    }
    return messages;
  }

  private decodeFrame(
    type: NativeMacCaptureMessageType,
    payload: Buffer,
  ): NativeMacCaptureMessage {
    switch (type) {
      case NativeMacCaptureMessageType.Ready: {
        if (this.readyReceived) {
          throw new Error("Native capture protocol received more than one ready frame.");
        }
        const message = decodeReady(payload);
        this.readyReceived = true;
        return message;
      }
      case NativeMacCaptureMessageType.Pcm:
        if (!this.readyReceived) {
          throw new Error("Native capture protocol received PCM before ready.");
        }
        return decodePcm(payload);
      case NativeMacCaptureMessageType.Error:
        return decodeError(payload);
      case NativeMacCaptureMessageType.Stopped:
        if (!this.readyReceived) {
          throw new Error("Native capture protocol received stopped before ready.");
        }
        if (payload.byteLength !== 0) {
          throw new Error("Native capture stopped frame must have an empty payload.");
        }
        this.stoppedReceived = true;
        return { type: "stopped" };
    }
  }
}

export function encodeNativeMacCaptureFrame(
  type: NativeMacCaptureMessageType,
  payload: Uint8Array,
): Buffer {
  if (!isNativeMacCaptureMessageType(type)) {
    throw new Error(`Unknown native capture message type: ${String(type)}.`);
  }
  if (payload.byteLength > MAXIMUM_NATIVE_CAPTURE_PAYLOAD_BYTES) {
    throw new Error(
      `Native capture payload is ${payload.byteLength} bytes; maximum is ${MAXIMUM_NATIVE_CAPTURE_PAYLOAD_BYTES}.`,
    );
  }
  const frame = Buffer.allocUnsafe(
    NATIVE_MAC_CAPTURE_HEADER_BYTES + payload.byteLength,
  );
  frame[0] = type;
  frame.writeUInt32LE(payload.byteLength, 1);
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(
    frame,
    NATIVE_MAC_CAPTURE_HEADER_BYTES,
  );
  return frame;
}

function decodeReady(payload: Buffer): NativeMacCaptureReadyMessage {
  const value = decodeJsonObject(payload, "ready");
  if (
    value.protocolVersion !== NATIVE_MAC_CAPTURE_PROTOCOL_VERSION ||
    value.sampleRateHz !== NATIVE_MAC_CAPTURE_SAMPLE_RATE_HZ ||
    value.channels !== NATIVE_MAC_CAPTURE_CHANNELS ||
    value.sampleFormat !== NATIVE_MAC_CAPTURE_SAMPLE_FORMAT ||
    !(value.defaultInputDeviceName === null ||
      typeof value.defaultInputDeviceName === "string")
  ) {
    throw new Error("Native capture ready frame does not match protocol version 1.");
  }
  return {
    type: "ready",
    protocolVersion: NATIVE_MAC_CAPTURE_PROTOCOL_VERSION,
    sampleRateHz: NATIVE_MAC_CAPTURE_SAMPLE_RATE_HZ,
    channels: NATIVE_MAC_CAPTURE_CHANNELS,
    sampleFormat: NATIVE_MAC_CAPTURE_SAMPLE_FORMAT,
    defaultInputDeviceName: value.defaultInputDeviceName,
  };
}

function decodePcm(payload: Buffer): NativeMacCapturePcmMessage {
  if (payload.byteLength === 0) {
    throw new Error("Native capture PCM payload must not be empty.");
  }
  if (payload.byteLength % Int16Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("Native capture PCM payload has an odd byte length.");
  }
  // The helper enforces 320-sample emission. The transport parser intentionally
  // accepts any nonempty even payload so transport tests can use compact frames.
  const samples = new Int16Array(
    payload.byteLength / Int16Array.BYTES_PER_ELEMENT,
  );
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = payload.readInt16LE(index * Int16Array.BYTES_PER_ELEMENT);
  }
  return { type: "pcm", samples };
}

function decodeError(payload: Buffer): NativeMacCaptureErrorMessage {
  const value = decodeJsonObject(payload, "error");
  if (typeof value.message !== "string" || value.message.trim().length === 0) {
    throw new Error("Native capture error frame must contain a message.");
  }
  return { type: "error", message: value.message };
}

function decodeJsonObject(
  payload: Buffer,
  frameName: string,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(payload.toString("utf8"));
  } catch (error) {
    throw new Error(`Native capture ${frameName} frame contains invalid JSON.`, {
      cause: error,
    });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Native capture ${frameName} frame must contain a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function isNativeMacCaptureMessageType(
  value: number | undefined,
): value is NativeMacCaptureMessageType {
  return (
    value === NativeMacCaptureMessageType.Ready ||
    value === NativeMacCaptureMessageType.Pcm ||
    value === NativeMacCaptureMessageType.Error ||
    value === NativeMacCaptureMessageType.Stopped
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
