import type {
  AppConfig,
  AppPaths,
  SessionResultPayload,
  TranscriptionProfile,
} from "../../core/index.js";

export interface AudioSignalMetrics {
  peakDecibels: number;
  rmsDecibels: number;
  probablySilent: boolean;
}

export interface StoppedCapture {
  sessionId: string;
  transcriptionProfile: TranscriptionProfile;
  startedAt: Date;
  stoppedAt: Date;
  prebufferMilliseconds: number;
  samples: Int16Array | readonly number[];
  signalMetrics: AudioSignalMetrics;
}

export type ServerState = "stopped" | "starting" | "ready";

export interface DiskSpaceStatus {
  availableBytes: number;
  lowSpace: boolean;
  criticalSpace: boolean;
  summary: string;
}

export type DiskStatusProvider = (
  path: string,
) => DiskSpaceStatus | null | Promise<DiskSpaceStatus | null>;

export interface Clock {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
  uuid(): string;
}

export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type HttpFetcher = (
  input: string,
  init: RequestInit,
) => Promise<FetchResponse>;

export interface ManagedProcess {
  readonly pid: number;
  readonly command: string;
  isRunning(): boolean;
  terminate(): void;
  kill(): void;
  waitForExit(): Promise<void>;
}

export interface ProcessRunOptions {
  timeoutMilliseconds: number;
  environment?: NodeJS.ProcessEnv;
}

export interface ProcessRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  terminationConfirmed?: boolean;
}

export interface ListeningProcess {
  pid: number;
  command: string;
}

export interface ProcessSpawner {
  spawnServer(
    command: string,
    args: readonly string[],
    logPath: string,
  ): Promise<ManagedProcess>;
  run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions,
  ): Promise<ProcessRunResult>;
  listeningProcesses(port: number): Promise<ListeningProcess[]>;
  terminatePid(pid: number, force: boolean): Promise<void>;
  processIsRunning(pid: number): boolean;
}

export interface TranscriptionManagerDependencies {
  fetcher?: HttpFetcher;
  processSpawner?: ProcessSpawner;
  clock?: Clock;
  cliEnvironment?: NodeJS.ProcessEnv;
  diskStatusProvider?: DiskStatusProvider;
  errorReporter?: (error: Error) => void;
}

export interface TranscriptionManagerOptions {
  config: AppConfig;
  paths: AppPaths;
  onCompleted: (result: SessionResultPayload) => void;
  dependencies?: TranscriptionManagerDependencies;
}
