import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const HISTORY_FILENAME = "history.jsonl";
export const HISTORY_ENTRY_LIMIT = 1_000;

export interface HistoryEntry {
  sessionId: string;
  text: string;
  profile: string;
  completedAt: string;
  audioDurationMilliseconds: number;
  transcriptionMilliseconds: number;
  transcriptionMode: string;
}

export interface HistoryStoreOptions {
  userDataPath: string;
  persistHistory?: boolean;
  entryLimit?: number;
}

export class HistoryStore {
  readonly filePath: string;
  private readonly persistHistory: boolean;
  private readonly entryLimit: number;
  private operationTail: Promise<void> = Promise.resolve();
  private entryCount: number | null = null;

  constructor(options: HistoryStoreOptions) {
    this.filePath = path.join(options.userDataPath, HISTORY_FILENAME);
    this.persistHistory = options.persistHistory ?? true;
    this.entryLimit = options.entryLimit ?? HISTORY_ENTRY_LIMIT;
    if (!Number.isSafeInteger(this.entryLimit) || this.entryLimit < 1) {
      throw new Error("History entry limit must be a positive integer.");
    }
  }

  append(entry: HistoryEntry): Promise<void> {
    if (!this.persistHistory) {
      return Promise.resolve();
    }

    const serialized = `${JSON.stringify(normalizeEntry(entry))}\n`;
    return this.enqueue(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, serialized, { encoding: "utf8", mode: 0o600 });
      this.entryCount =
        this.entryCount === null
          ? (await readEntries(this.filePath)).length
          : this.entryCount + 1;
      if (this.entryCount > this.entryLimit) {
        const entries = (await readEntries(this.filePath)).slice(-this.entryLimit);
        await replaceFile(
          this.filePath,
          serializeEntries(entries),
        );
        this.entryCount = entries.length;
      }
    });
  }

  read(): Promise<HistoryEntry[]> {
    return this.enqueue(async () => {
      const entries = await readEntries(this.filePath);
      this.entryCount = entries.length;
      return entries;
    });
  }

  clear(): Promise<void> {
    return this.enqueue(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, "", { encoding: "utf8", mode: 0o600 });
      this.entryCount = 0;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

async function readEntries(filePath: string): Promise<HistoryEntry[]> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }

  const entries: HistoryEntry[] = [];
  for (const line of contents.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const entry = decodeEntry(JSON.parse(line) as unknown);
      if (entry !== null) {
        entries.push(entry);
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
    }
  }
  return entries;
}

function normalizeEntry(entry: HistoryEntry): HistoryEntry {
  const normalized = decodeEntry(entry);
  if (normalized === null) {
    throw new Error("History entry is invalid.");
  }
  return normalized;
}

function decodeEntry(value: unknown): HistoryEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const source = value as Record<string, unknown>;
  if (
    typeof source.sessionId !== "string" ||
    typeof source.text !== "string" ||
    typeof source.profile !== "string" ||
    typeof source.completedAt !== "string" ||
    typeof source.audioDurationMilliseconds !== "number" ||
    !Number.isFinite(source.audioDurationMilliseconds) ||
    typeof source.transcriptionMilliseconds !== "number" ||
    !Number.isFinite(source.transcriptionMilliseconds) ||
    typeof source.transcriptionMode !== "string"
  ) {
    return null;
  }
  if (Number.isNaN(Date.parse(source.completedAt))) {
    return null;
  }

  return {
    sessionId: source.sessionId,
    text: source.text,
    profile: source.profile,
    completedAt: source.completedAt,
    audioDurationMilliseconds: source.audioDurationMilliseconds,
    transcriptionMilliseconds: source.transcriptionMilliseconds,
    transcriptionMode: source.transcriptionMode,
  };
}

function serializeEntries(entries: readonly HistoryEntry[]): string {
  if (entries.length === 0) {
    return "";
  }
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

async function replaceFile(filePath: string, contents: string): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, filePath);
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
