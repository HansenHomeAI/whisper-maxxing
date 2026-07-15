export class TranscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptionError";
  }

  static serverHTTP(status: number): TranscriptionError {
    return new TranscriptionError(`whisper-server returned HTTP ${status}`);
  }

  static serverTimeout(seconds: number): TranscriptionError {
    return new TranscriptionError(
      `whisper-server timed out after ${Math.trunc(seconds)} seconds`,
    );
  }

  static cliTimeout(seconds: number): TranscriptionError {
    return new TranscriptionError(
      `whisper-cli timed out after ${Math.trunc(seconds)} seconds`,
    );
  }

  static robustModelNotConfigured(): TranscriptionError {
    return new TranscriptionError(
      "Robust dictation model is not configured. Reinstall with WHISPER_ROBUST_MODEL_PATH.",
    );
  }

  static noRetryableCapture(): TranscriptionError {
    return new TranscriptionError(
      "No previous recording is available to retranscribe.",
    );
  }

  static combined(server: unknown, cli: unknown): TranscriptionError {
    return new TranscriptionError(
      `Server failed: ${errorMessage(server)}. CLI fallback failed: ${errorMessage(cli)}`,
    );
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  return "Transcription Failed";
}
