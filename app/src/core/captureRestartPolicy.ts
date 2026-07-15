export type CaptureRestartAction = "retry" | "restartProcess";

export interface CaptureRestartDecision {
  action: CaptureRestartAction;
  reason: "capture-restart-failed" | "capture-restart-failed-repeatedly";
}

export const MAXIMUM_CONSECUTIVE_FAILURES = 3;

export function assessCaptureRestart(
  consecutiveFailureCount: number,
): CaptureRestartDecision {
  if (consecutiveFailureCount >= MAXIMUM_CONSECUTIVE_FAILURES) {
    return {
      action: "restartProcess",
      reason: "capture-restart-failed-repeatedly",
    };
  }

  return { action: "retry", reason: "capture-restart-failed" };
}
