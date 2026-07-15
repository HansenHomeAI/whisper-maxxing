import type {
  ControlRequest,
  ControlResponse,
  SessionResultPayload,
  StatusPayload,
  TranscriptionProfile,
} from "../../core/controlProtocol.js";

export type { SessionResultPayload, StatusPayload, TranscriptionProfile };

export interface ControlClient {
  send(request: ControlRequest): Promise<ControlResponse>;
}

export interface AlertSink {
  showAlert(message: string): void | Promise<void>;
}

export interface OverlaySink {
  showRecording(profile: TranscriptionProfile): void | Promise<void>;
  hideRecording(): void | Promise<void>;
}

export interface ReplacementTarget {
  originalSessionId: string;
  originalProfile: TranscriptionProfile;
  pastedAtSeconds: number;
  appIdentity: string | null;
  requestedAtSeconds: number;
}

export interface PasteEnginePort {
  frontmostAppIdentity(): Promise<string | null>;
  paste(text: string, replacementTarget?: ReplacementTarget): Promise<void>;
}

export interface Scheduler {
  nowSeconds(): number;
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface Logger {
  error(message: string): void;
  info(message: string): void;
}

export const systemScheduler: Scheduler = {
  nowSeconds: () => Date.now() / 1_000,
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export const consoleLogger: Logger = {
  error: (message) => console.error(message),
  info: (message) => console.info(message),
};
