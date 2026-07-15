export interface CaptureIntegrityAssessment {
  capturedAudioMilliseconds: number;
  prebufferMilliseconds: number;
  captureWallClockMilliseconds: number;
  activeAudioMilliseconds: number;
  droppedMilliseconds: number;
  coverageRatio: number;
  requiresFailure: boolean;
  reason: "capture-stalled" | "capture-duration-gap" | null;
}

const MINIMUM_STALLED_WALL_CLOCK_MILLISECONDS = 1_000;
const MAXIMUM_STALLED_ACTIVE_AUDIO_MILLISECONDS = 250;
const MINIMUM_WALL_CLOCK_MILLISECONDS = 5_000;
const ALLOWED_DROPPED_MILLISECONDS = 2_000;
const MINIMUM_COVERAGE_RATIO = 0.8;

export function assessCaptureIntegrity(
  capturedAudioMilliseconds: number,
  prebufferMilliseconds: number,
  captureWallClockMilliseconds: number,
): CaptureIntegrityAssessment {
  const wallClock = Math.max(captureWallClockMilliseconds, 0);
  const activeAudio = Math.max(
    capturedAudioMilliseconds - Math.max(prebufferMilliseconds, 0),
    0,
  );
  const dropped = Math.max(wallClock - activeAudio, 0);
  const coverage = wallClock > 0 ? Math.min(activeAudio / wallClock, 1) : 1;
  const captureStalled =
    wallClock >= MINIMUM_STALLED_WALL_CLOCK_MILLISECONDS &&
    activeAudio <= MAXIMUM_STALLED_ACTIVE_AUDIO_MILLISECONDS &&
    dropped > MAXIMUM_STALLED_ACTIVE_AUDIO_MILLISECONDS;
  const hasLargeGap =
    wallClock >= MINIMUM_WALL_CLOCK_MILLISECONDS &&
    dropped > ALLOWED_DROPPED_MILLISECONDS &&
    coverage < MINIMUM_COVERAGE_RATIO;
  const reason = captureStalled
    ? "capture-stalled"
    : hasLargeGap
      ? "capture-duration-gap"
      : null;

  return {
    capturedAudioMilliseconds,
    prebufferMilliseconds,
    captureWallClockMilliseconds: wallClock,
    activeAudioMilliseconds: activeAudio,
    droppedMilliseconds: dropped,
    coverageRatio: coverage,
    requiresFailure: reason !== null,
    reason,
  };
}
