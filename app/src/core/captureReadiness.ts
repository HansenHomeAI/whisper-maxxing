export interface CaptureReadinessAssessment {
  ready: boolean;
  reason:
    | "capture-engine-stopped"
    | "capture-buffer-missing"
    | "capture-buffer-stale"
    | null;
  secondsSinceLastBuffer: number | null;
}

export const MAXIMUM_BUFFER_AGE_SECONDS = 2;

export function assessCaptureReadiness(
  engineRunning: boolean,
  startupSignaled: boolean,
  secondsSinceLastBuffer: number | null,
): CaptureReadinessAssessment {
  let reason: CaptureReadinessAssessment["reason"] = null;
  if (!engineRunning) {
    reason = "capture-engine-stopped";
  } else if (!startupSignaled) {
    reason = "capture-buffer-missing";
  } else if (
    secondsSinceLastBuffer !== null &&
    secondsSinceLastBuffer > MAXIMUM_BUFFER_AGE_SECONDS
  ) {
    reason = "capture-buffer-stale";
  } else if (secondsSinceLastBuffer === null) {
    reason = "capture-buffer-missing";
  }

  return {
    ready: reason === null,
    reason,
    secondsSinceLastBuffer,
  };
}
