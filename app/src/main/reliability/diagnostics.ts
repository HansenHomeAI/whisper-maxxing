import { appendFile, chmod, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const RETENTION_MILLISECONDS = 24 * 60 * 60 * 1_000;
const CLEANUP_GRACE_MILLISECONDS = 60 * 60 * 1_000;
const MAX_MESSAGE_LENGTH = 500;

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface DiagnosticEvent {
  severity?: DiagnosticSeverity;
  component: "app" | "capture" | "transcription" | "delivery" | "recovery";
  event: string;
  sessionId?: string | null;
  code?: string | null;
  message?: string | null;
  fields?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface DiagnosticRecord extends DiagnosticEvent {
  schemaVersion: 1;
  timestamp: string;
  processInstanceId: string;
}

export class LocalDiagnostics {
  private readonly roots: readonly string[];
  private writeChain: Promise<void> = Promise.resolve();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly directory: string,
    readonly processInstanceId: string,
    readonly enabled: boolean,
    sensitiveRoots: readonly string[] = [],
  ) {
    this.roots = sensitiveRoots.filter((root) => root.length > 0);
  }

  async initialize(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700).catch(() => undefined);
    await this.cleanup();
    this.cleanupTimer = setInterval(() => {
      void this.cleanup().catch(() => undefined);
    }, 60 * 60 * 1_000);
    this.cleanupTimer.unref();
  }

  record(event: DiagnosticEvent): void {
    if (!this.enabled) {
      return;
    }
    const record: DiagnosticRecord = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      processInstanceId: this.processInstanceId,
      severity: event.severity ?? "info",
      component: event.component,
      event: safeToken(event.event),
      sessionId: event.sessionId ?? null,
      code: event.code ? safeToken(event.code) : null,
      message: event.message ? this.scrub(event.message) : null,
      ...(event.fields === undefined ? {} : { fields: sanitizeFields(event.fields) }),
    };
    this.writeChain = this.writeChain
      .then(async () => {
        const path = this.pathFor(record.timestamp);
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await appendFile(path, `${JSON.stringify(record)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await chmod(path, 0o600).catch(() => undefined);
      })
      .catch(() => undefined);
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  async cleanup(now = Date.now()): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const cutoff = now - RETENTION_MILLISECONDS - CLEANUP_GRACE_MILLISECONDS;
    const entries = await readdir(this.directory).catch(() => [] as string[]);
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith("diagnostics-") && entry.endsWith(".jsonl"))
        .map(async (entry) => {
          const path = join(this.directory, entry);
          const details = await stat(path).catch(() => null);
          if (details !== null && details.mtimeMs < cutoff) {
            await rm(path, { force: true });
          }
        }),
    );
  }

  async records(sinceMilliseconds = RETENTION_MILLISECONDS): Promise<DiagnosticRecord[]> {
    if (!this.enabled) {
      return [];
    }
    await this.flush();
    const cutoff = Date.now() - Math.min(Math.max(sinceMilliseconds, 0), RETENTION_MILLISECONDS);
    const entries = await readdir(this.directory).catch(() => [] as string[]);
    const records: DiagnosticRecord[] = [];
    for (const entry of entries.sort()) {
      if (!entry.startsWith("diagnostics-") || !entry.endsWith(".jsonl")) {
        continue;
      }
      const content = await readFile(join(this.directory, entry), "utf8").catch(() => "");
      for (const line of content.split("\n")) {
        if (line.length === 0) {
          continue;
        }
        try {
          const record = JSON.parse(line) as DiagnosticRecord;
          if (Date.parse(record.timestamp) >= cutoff) {
            records.push(record);
          }
        } catch {
          // A torn final line must not hide earlier valid diagnostic records.
        }
      }
    }
    return records;
  }

  private pathFor(timestamp: string): string {
    return join(this.directory, `diagnostics-${timestamp.slice(0, 10)}.jsonl`);
  }

  private scrub(message: string): string {
    let scrubbed = message.replace(/[\r\n\t]+/g, " ");
    for (const root of this.roots) {
      scrubbed = scrubbed.split(root).join("<LOCAL_PATH>");
    }
    return scrubbed.slice(0, MAX_MESSAGE_LENGTH);
  }
}

function safeToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 100);
}

function sanitizeFields(
  fields: Readonly<Record<string, string | number | boolean | null>>,
): Readonly<Record<string, string | number | boolean | null>> {
  return Object.fromEntries(
    Object.entries(fields).slice(0, 20).map(([key, value]) => [safeToken(key), value]),
  );
}

export function diagnosticsDirectoryFromLogPath(daemonLogPath: string): string {
  return join(dirname(daemonLogPath), "diagnostics");
}
