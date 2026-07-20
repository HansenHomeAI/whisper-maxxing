import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import type { TranscriptionProfile } from "../../core/controlProtocol.js";
import type { LocalDiagnostics } from "./diagnostics.js";

const HEADER_BYTES = 44;
const SAMPLE_RATE = 16_000;
const RETENTION_MILLISECONDS = 24 * 60 * 60 * 1_000;
const CLEANUP_GRACE_MILLISECONDS = 60 * 60 * 1_000;
const SYNC_INTERVAL_MILLISECONDS = 1_000;
const MAX_QUEUED_BYTES = 2 * SAMPLE_RATE * 2;
const DISK_RESERVE_BYTES = 2 * 1024 * 1024 * 1024;
const RECOVERY_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;
const DELIVERY_DELETE_DELAY_MILLISECONDS = 10_000;

export type RecoveryState =
  | "active"
  | "awaiting_delivery"
  | "retained"
  | "cancelled";

export interface RecoveryMetadata {
  schemaVersion: 1;
  sessionId: string;
  transcriptionProfile: TranscriptionProfile;
  startedAt: string;
  stoppedAt: string | null;
  prebufferMilliseconds: number;
  sampleCount: number;
  committedSampleCount: number;
  state: RecoveryState;
  reason: string | null;
  terminalAt: string | null;
  expiresAt: string | null;
}

export interface RecoveryEntry extends RecoveryMetadata {
  wavPath: string;
  fileSizeBytes: number;
}

export interface FinalizedRecovery {
  wavPath: string;
  metadata: RecoveryMetadata;
}

export interface RecoveryStoreOptions {
  directory: string;
  enabled: boolean;
  diagnostics: LocalDiagnostics;
  persistRecentCaptures: boolean;
}

export class RecoveryStore {
  readonly directory: string;
  readonly enabled: boolean;
  private readonly diagnostics: LocalDiagnostics;
  private readonly persistRecentCaptures: boolean;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly deletionTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: RecoveryStoreOptions) {
    this.directory = options.directory;
    this.enabled = options.enabled;
    this.diagnostics = options.diagnostics;
    this.persistRecentCaptures = options.persistRecentCaptures;
  }

  async initialize(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700).catch(() => undefined);
    await this.recoverAbandoned();
    await this.recoverFinalizedActive();
    await this.cleanup();
    this.cleanupTimer = setInterval(() => {
      void this.cleanup().catch(() => undefined);
    }, 60 * 60 * 1_000);
    this.cleanupTimer.unref();
  }

  async createSpool(
    sessionId: string,
    profile: TranscriptionProfile,
    startedAt: Date,
    prebuffer: Int16Array,
  ): Promise<RecordingSpool | null> {
    if (!this.enabled) {
      return null;
    }
    await this.assertDiskReserve();
    const metadata: RecoveryMetadata = {
      schemaVersion: 1,
      sessionId,
      transcriptionProfile: profile,
      startedAt: startedAt.toISOString(),
      stoppedAt: null,
      prebufferMilliseconds: prebuffer.length / 16,
      sampleCount: 0,
      committedSampleCount: 0,
      state: "active",
      reason: null,
      terminalAt: null,
      expiresAt: null,
    };
    const spool = await RecordingSpool.create(
      this.partPath(sessionId),
      this.metadataPath(sessionId),
      metadata,
      this.diagnostics,
    );
    spool.append(prebuffer);
    await spool.checkpoint();
    return spool;
  }

  async retain(sessionId: string, reason: string): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const metadata = await this.readMetadata(sessionId);
    if (metadata === null) {
      return;
    }
    const now = new Date();
    metadata.state = "retained";
    metadata.reason = reason;
    metadata.terminalAt = now.toISOString();
    metadata.expiresAt = new Date(now.getTime() + RETENTION_MILLISECONDS).toISOString();
    await this.writeMetadata(metadata);
    this.diagnostics.record({
      component: "recovery",
      event: "recording_retained",
      sessionId,
      code: reason,
    });
  }

  async awaitingDelivery(sessionId: string): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const metadata = await this.readMetadata(sessionId);
    if (metadata === null) {
      return;
    }
    metadata.state = "awaiting_delivery";
    metadata.reason = "awaiting_delivery";
    metadata.terminalAt = new Date().toISOString();
    metadata.expiresAt = new Date(Date.now() + RETENTION_MILLISECONDS).toISOString();
    await this.writeMetadata(metadata);
  }

  async acknowledge(
    sessionId: string,
    outcome: "delivered" | "pasteFailed" | "noOutput",
  ): Promise<void> {
    if (!this.enabled) {
      return;
    }
    this.diagnostics.record({
      component: "delivery",
      event: "result_acknowledged",
      sessionId,
      fields: { outcome },
    });
    if (outcome !== "delivered" || this.persistRecentCaptures) {
      await this.retain(sessionId, outcome);
      return;
    }
    this.hold(sessionId);
    const timer = setTimeout(() => {
      this.deletionTimers.delete(sessionId);
      void this.removeSession(sessionId).catch(() => undefined);
    }, DELIVERY_DELETE_DELAY_MILLISECONDS);
    timer.unref();
    this.deletionTimers.set(sessionId, timer);
  }

  hold(sessionId: string): void {
    const timer = this.deletionTimers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.deletionTimers.delete(sessionId);
    }
  }

  async list(): Promise<RecoveryEntry[]> {
    if (!this.enabled) {
      return [];
    }
    const entries = await readdir(this.directory).catch(() => [] as string[]);
    const results: RecoveryEntry[] = [];
    for (const entry of entries.filter((value) => value.endsWith(".json"))) {
      const metadata = await this.readMetadata(entry.slice(0, -5));
      if (metadata === null || metadata.state === "cancelled") {
        continue;
      }
      const wavPath = this.wavPath(metadata.sessionId);
      const details = await stat(wavPath).catch(() => null);
      if (details !== null) {
        results.push({ ...metadata, wavPath, fileSizeBytes: details.size });
      }
    }
    return results.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  async export(sessionId: string, destination: string): Promise<void> {
    const metadata = await this.readMetadata(sessionId);
    if (metadata === null || metadata.state === "active") {
      throw new Error("Recovery recording was not found.");
    }
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(this.wavPath(sessionId), destination);
    this.diagnostics.record({
      component: "recovery",
      event: "recording_exported",
      sessionId,
    });
  }

  async cleanup(now = Date.now()): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const entries = await this.list();
    for (const entry of entries) {
      const expiresAt = entry.expiresAt === null ? null : Date.parse(entry.expiresAt);
      if (
        entry.state !== "active" &&
        expiresAt !== null &&
        expiresAt + CLEANUP_GRACE_MILLISECONDS <= now
      ) {
        await this.removeSession(entry.sessionId);
        this.diagnostics.record({
          component: "recovery",
          event: "recording_expired",
          sessionId: entry.sessionId,
        });
      }
    }
    await this.enforceSizeLimit();
  }

  async removeSession(sessionId: string): Promise<void> {
    this.hold(sessionId);
    await Promise.all([
      rm(this.wavPath(sessionId), { force: true }),
      rm(this.partPath(sessionId), { force: true }),
      rm(this.metadataPath(sessionId), { force: true }),
    ]);
  }

  private async recoverAbandoned(): Promise<void> {
    const entries = await readdir(this.directory).catch(() => [] as string[]);
    for (const entry of entries.filter((value) => value.endsWith(".wav.part"))) {
      const sessionId = entry.slice(0, -9);
      const partPath = this.partPath(sessionId);
      const details = await stat(partPath).catch(() => null);
      if (details === null || details.size < HEADER_BYTES) {
        await this.removeSession(sessionId);
        continue;
      }
      const alignedSize = details.size - ((details.size - HEADER_BYTES) % 2);
      const handle = await open(partPath, "r+");
      try {
        await handle.truncate(alignedSize);
        await handle.write(wavHeader(alignedSize - HEADER_BYTES), 0, HEADER_BYTES, 0);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(partPath, this.wavPath(sessionId));
      let metadata = await this.readMetadata(sessionId);
      const recoveredAt = new Date();
      metadata ??= {
        schemaVersion: 1,
        sessionId,
        transcriptionProfile: "fast",
        startedAt: recoveredAt.toISOString(),
        stoppedAt: recoveredAt.toISOString(),
        prebufferMilliseconds: 0,
        sampleCount: (alignedSize - HEADER_BYTES) / 2,
        committedSampleCount: (alignedSize - HEADER_BYTES) / 2,
        state: "retained",
        reason: "interrupted",
        terminalAt: recoveredAt.toISOString(),
        expiresAt: new Date(recoveredAt.getTime() + RETENTION_MILLISECONDS).toISOString(),
      };
      metadata.sampleCount = (alignedSize - HEADER_BYTES) / 2;
      metadata.committedSampleCount = metadata.sampleCount;
      metadata.stoppedAt = recoveredAt.toISOString();
      metadata.state = "retained";
      metadata.reason = "interrupted";
      metadata.terminalAt = recoveredAt.toISOString();
      metadata.expiresAt = new Date(recoveredAt.getTime() + RETENTION_MILLISECONDS).toISOString();
      await this.writeMetadata(metadata);
      this.diagnostics.record({
        component: "recovery",
        event: "recording_recovered",
        sessionId,
        fields: { sampleCount: metadata.sampleCount },
      });
    }
  }

  private async recoverFinalizedActive(): Promise<void> {
    const entries = await readdir(this.directory).catch(() => [] as string[]);
    for (const entry of entries.filter((value) => value.endsWith(".json"))) {
      const sessionId = entry.slice(0, -5);
      const metadata = await this.readMetadata(sessionId);
      if (metadata?.state !== "active") {
        continue;
      }
      const details = await stat(this.wavPath(sessionId)).catch(() => null);
      if (details !== null) {
        await this.retain(sessionId, "interrupted");
      }
    }
  }

  private async assertDiskReserve(): Promise<void> {
    const details = await statfs(this.directory).catch(async () => statfs(dirname(this.directory)));
    const availableBytes = Number(details.bavail) * Number(details.bsize);
    if (availableBytes < DISK_RESERVE_BYTES) {
      throw new Error("Recording storage is below the 2 GiB safety reserve.");
    }
  }

  private async enforceSizeLimit(): Promise<void> {
    const entries = (await this.list()).filter((entry) => entry.state !== "active");
    let total = entries.reduce((sum, entry) => sum + entry.fileSizeBytes, 0);
    for (const entry of entries.sort((left, right) => left.startedAt.localeCompare(right.startedAt))) {
      if (total <= RECOVERY_LIMIT_BYTES) {
        break;
      }
      await this.removeSession(entry.sessionId);
      total -= entry.fileSizeBytes;
      this.diagnostics.record({
        severity: "warning",
        component: "recovery",
        event: "recording_emergency_deleted",
        sessionId: entry.sessionId,
      });
    }
  }

  private wavPath(sessionId: string): string {
    return join(this.directory, `${sessionId}.wav`);
  }

  private partPath(sessionId: string): string {
    return join(this.directory, `${sessionId}.wav.part`);
  }

  private metadataPath(sessionId: string): string {
    return join(this.directory, `${sessionId}.json`);
  }

  private async readMetadata(sessionId: string): Promise<RecoveryMetadata | null> {
    try {
      return JSON.parse(await readFile(this.metadataPath(sessionId), "utf8")) as RecoveryMetadata;
    } catch {
      return null;
    }
  }

  private async writeMetadata(metadata: RecoveryMetadata): Promise<void> {
    await writeJsonAtomically(this.metadataPath(metadata.sessionId), metadata);
  }
}

export class RecordingSpool {
  private readonly queued: Buffer[] = [];
  private queuedBytes = 0;
  private draining: Promise<void> | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private peakMagnitude = 0;
  private sumSquares = 0;
  private failure: Error | null = null;
  private lastHealthLoggedAt = Date.now();
  private writeOffset = HEADER_BYTES;

  private constructor(
    private readonly partPath: string,
    private readonly metadataPath: string,
    private readonly handle: FileHandle,
    readonly metadata: RecoveryMetadata,
    private readonly diagnostics: LocalDiagnostics,
  ) {}

  static async create(
    partPath: string,
    metadataPath: string,
    metadata: RecoveryMetadata,
    diagnostics: LocalDiagnostics,
  ): Promise<RecordingSpool> {
    await mkdir(dirname(partPath), { recursive: true, mode: 0o700 });
    const handle = await open(partPath, "wx+", 0o600);
    await handle.write(wavHeader(0), 0, HEADER_BYTES, 0);
    await handle.sync();
    await writeJsonAtomically(metadataPath, metadata);
    const spool = new RecordingSpool(partPath, metadataPath, handle, metadata, diagnostics);
    spool.syncTimer = setInterval(() => {
      void spool.checkpoint().catch((error: unknown) => {
        diagnostics.record({
          severity: "error",
          component: "capture",
          event: "checkpoint_failed",
          sessionId: metadata.sessionId,
          code: "recovery_write_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }, SYNC_INTERVAL_MILLISECONDS);
    spool.syncTimer.unref();
    return spool;
  }

  append(samples: Int16Array): void {
    if (this.failure !== null) {
      throw this.failure;
    }
    if (this.closed || samples.length === 0) {
      return;
    }
    const data = Buffer.allocUnsafe(samples.length * 2);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index] ?? 0;
      data.writeInt16LE(sample, index * 2);
      const normalized = Math.abs(sample) / 32_767;
      this.peakMagnitude = Math.max(this.peakMagnitude, normalized);
      this.sumSquares += normalized * normalized;
    }
    if (this.queuedBytes + data.byteLength > MAX_QUEUED_BYTES) {
      throw new Error("Recording storage queue overflowed.");
    }
    this.queued.push(data);
    this.queuedBytes += data.byteLength;
    this.metadata.sampleCount += samples.length;
    this.startDrain();
  }

  markStarted(): void {
    this.diagnostics.record({
      component: "capture",
      event: "capture_started",
      sessionId: this.metadata.sessionId,
      fields: { prebufferMilliseconds: this.metadata.prebufferMilliseconds },
    });
  }

  async checkpoint(): Promise<void> {
    await this.waitForDrain();
    if (this.failure !== null) {
      throw this.failure;
    }
    await this.handle.sync();
    this.metadata.committedSampleCount = this.metadata.sampleCount;
    await writeJsonAtomically(this.metadataPath, this.metadata);
    const now = Date.now();
    if (now - this.lastHealthLoggedAt >= 30_000) {
      this.lastHealthLoggedAt = now;
      this.diagnostics.record({
        component: "capture",
        event: "capture_health_checkpoint",
        sessionId: this.metadata.sessionId,
        fields: {
          sampleCount: this.metadata.sampleCount,
          committedSampleCount: this.metadata.committedSampleCount,
        },
      });
    }
  }

  async finalize(stoppedAt: Date): Promise<FinalizedRecovery> {
    this.closed = true;
    this.clearTimer();
    await this.checkpoint();
    const dataBytes = this.metadata.sampleCount * 2;
    await this.handle.write(wavHeader(dataBytes), 0, HEADER_BYTES, 0);
    await this.handle.sync();
    await this.handle.close();
    const wavPath = this.partPath.slice(0, -5);
    await rename(this.partPath, wavPath);
    this.metadata.stoppedAt = stoppedAt.toISOString();
    await writeJsonAtomically(this.metadataPath, this.metadata);
    this.diagnostics.record({
      component: "capture",
      event: "capture_finalized",
      sessionId: this.metadata.sessionId,
      fields: { sampleCount: this.metadata.sampleCount },
    });
    return { wavPath, metadata: this.metadata };
  }

  async cancel(): Promise<void> {
    this.closed = true;
    this.clearTimer();
    await this.waitForDrain().catch(() => undefined);
    await this.handle.close().catch(() => undefined);
    await Promise.all([
      rm(this.partPath, { force: true }),
      rm(this.partPath.slice(0, -5), { force: true }),
      rm(this.metadataPath, { force: true }),
    ]);
    this.diagnostics.record({
      component: "capture",
      event: "capture_cancelled",
      sessionId: this.metadata.sessionId,
    });
  }

  signalMetrics(): { peakDecibels: number; rmsDecibels: number; probablySilent: boolean } {
    const rmsMagnitude = this.metadata.sampleCount > 0
      ? Math.sqrt(this.sumSquares / this.metadata.sampleCount)
      : 0;
    const peakDecibels = decibels(this.peakMagnitude);
    const rmsDecibels = decibels(rmsMagnitude);
    return {
      peakDecibels,
      rmsDecibels,
      probablySilent: peakDecibels <= -50 && rmsDecibels <= -55,
    };
  }

  private startDrain(): void {
    if (this.draining !== null) {
      return;
    }
    this.draining = this.drain()
      .catch((error: unknown) => {
        this.failure = error instanceof Error ? error : new Error(String(error));
        this.diagnostics.record({
          severity: "error",
          component: "capture",
          event: "recording_write_failed",
          sessionId: this.metadata.sessionId,
          code: "recovery_write_failed",
          message: this.failure.message,
        });
      })
      .finally(() => {
        this.draining = null;
        if (this.queued.length > 0 && this.failure === null) {
          this.startDrain();
        }
      });
  }

  private async drain(): Promise<void> {
    while (this.queued.length > 0) {
      const data = this.queued.shift();
      if (data === undefined) {
        continue;
      }
      this.queuedBytes -= data.byteLength;
      await this.handle.write(data, 0, data.byteLength, this.writeOffset);
      this.writeOffset += data.byteLength;
    }
  }

  private async waitForDrain(): Promise<void> {
    while (this.draining !== null) {
      await this.draining;
    }
  }

  private clearTimer(): void {
    if (this.syncTimer !== null) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }
}

function wavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

function decibels(magnitude: number): number {
  return magnitude > 0 ? 20 * Math.log10(magnitude) : Number.NEGATIVE_INFINITY;
}

export function recoveryDirectoryFromTempDirectory(tempDirectory: string): string {
  return join(tempDirectory, "recovery");
}
