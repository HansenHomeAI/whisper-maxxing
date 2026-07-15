import { describe, expect, it } from "vitest";

import type {
  ControlRequest,
  ControlResponse,
  SessionResultPayload,
  StatusPayload,
} from "../../src/core/controlProtocol.js";
import { DictationController } from "../../src/main/ux/dictationController.js";
import type {
  ControlClient,
  Logger,
  PasteEnginePort,
  ReplacementTarget,
  Scheduler,
  TranscriptionProfile,
} from "../../src/main/ux/types.js";

class FakeScheduler implements Scheduler {
  now = 1_000;
  intervalMilliseconds: number[] = [];
  callbacks = new Map<object, () => void>();

  nowSeconds(): number {
    return this.now;
  }

  setInterval(callback: () => void, milliseconds: number): object {
    const handle = {};
    this.callbacks.set(handle, callback);
    this.intervalMilliseconds.push(milliseconds);
    return handle;
  }

  clearInterval(handle: unknown): void {
    this.callbacks.delete(handle as object);
  }
}

class FakePasteEngine implements PasteEnginePort {
  identity: string | null = "com.example.Editor";
  pastes: Array<{ text: string; target?: ReplacementTarget }> = [];
  failure: Error | null = null;

  async frontmostAppIdentity(): Promise<string | null> {
    return this.identity;
  }

  async paste(text: string, replacementTarget?: ReplacementTarget): Promise<void> {
    if (this.failure) {
      throw this.failure;
    }
    this.pastes.push(replacementTarget ? { text, target: replacementTarget } : { text });
  }
}

describe("DictationController", () => {
  it("does not double-send start and shows the current recording label", async () => {
    const harness = makeHarness([ok({ sessionId: "s1" })]);
    await harness.controller.startRecording("fast");
    await harness.controller.startRecording("fast");

    expect(harness.requests.map(({ command }) => command)).toEqual(["start"]);
    expect(harness.alerts).toEqual(["Starting", "Recording", "Recording"]);
    expect(harness.recordingProfiles).toEqual(["fast"]);
  });

  it("stops, enqueues the session, and starts a 150 ms poller", async () => {
    const harness = makeHarness([
      ok({ sessionId: "s1" }),
      ok({ sessionId: "s1", pendingCount: 1 }),
    ]);
    await harness.controller.startRecording("fast");
    await harness.controller.stopRecording(false);

    expect(harness.requests.map(({ command }) => command)).toEqual(["start", "stop"]);
    expect(harness.controller.snapshot()).toEqual({
      state: "idle",
      profile: "fast",
      pendingCount: 1,
      pendingSessionIds: ["s1"],
      polling: true,
    });
    expect(harness.scheduler.intervalMilliseconds).toEqual([150]);
    expect(harness.alerts.at(-1)).toBe("Processing Audio (1)");
  });

  it("cancels only an active recording", async () => {
    const harness = makeHarness([ok({ sessionId: "s1" }), ok()]);
    await harness.controller.cancelRecording();
    await harness.controller.startRecording("robust");
    await harness.controller.cancelRecording();

    expect(harness.requests.map(({ command }) => command)).toEqual(["startRobust", "cancel"]);
    expect(harness.alerts).toContain("No Session");
    expect(harness.alerts.at(-1)).toBe("Robust Recording Canceled");
    expect(harness.controller.snapshot().polling).toBe(false);
  });

  it("reaches stop and cancel even when hiding the overlay fails", async () => {
    const stopHarness = makeHarness([
      ok({ sessionId: "s1" }),
      ok({ sessionId: "s1", pendingCount: 1 }),
    ]);
    stopHarness.setHideFailure(new Error("renderer unavailable"));
    await stopHarness.controller.startRecording();
    await stopHarness.controller.stopRecording(false);
    expect(stopHarness.requests.map(({ command }) => command)).toEqual(["start", "stop"]);
    expect(stopHarness.controller.snapshot()).toMatchObject({ state: "idle", polling: true });
    expect(stopHarness.alerts.at(-1)).toBe("renderer unavailable");

    const cancelHarness = makeHarness([ok({ sessionId: "s2" }), ok()]);
    cancelHarness.setHideFailure(new Error("renderer unavailable"));
    await cancelHarness.controller.startRecording();
    await cancelHarness.controller.cancelRecording();
    expect(cancelHarness.requests.map(({ command }) => command)).toEqual([
      "start",
      "cancel",
    ]);
    expect(cancelHarness.controller.snapshot().state).toBe("idle");
  });

  it("guards robust retry while recording", async () => {
    const harness = makeHarness([ok({ sessionId: "s1" })]);
    await harness.controller.startRecording("fast");
    await harness.controller.retryRobustTranscription();

    expect(harness.requests.map(({ command }) => command)).toEqual(["start"]);
    expect(harness.alerts.at(-1)).toBe("Stop Recording First");
  });

  it("reconciles state when the daemon watchdog drifts", async () => {
    const harness = makeHarness([
      ok({ status: status({ recording: true, recordingProfile: "robust" }) }),
      ok({ status: status({ recording: false }) }),
    ]);
    await harness.controller.watchDaemonStatus();
    expect(harness.controller.snapshot().state).toBe("recording");
    expect(harness.recordingProfiles).toEqual(["robust"]);

    await harness.controller.watchDaemonStatus();
    expect(harness.controller.snapshot().state).toBe("idle");
    expect(harness.hiddenCount).toBe(1);
  });

  it("ignores a stale watchdog response after a newer start", async () => {
    let resolveStatus: ((response: ControlResponse) => void) | undefined;
    const requests: ControlRequest[] = [];
    const alerts: string[] = [];
    const controller = new DictationController({
      controlClient: {
        send(request) {
          requests.push(request);
          if (request.command === "status") {
            return new Promise((resolve) => {
              resolveStatus = resolve;
            });
          }
          return Promise.resolve(ok({ sessionId: "new-session" }));
        },
      },
      alerts: {
        showAlert(message) {
          alerts.push(message);
        },
      },
      overlay: { showRecording: () => undefined, hideRecording: () => undefined },
      pasteEngine: new FakePasteEngine(),
    });

    const watchdog = controller.watchDaemonStatus();
    await Promise.resolve();
    await controller.startRecording();
    resolveStatus?.(ok({ status: status({ recording: false }) }));
    await watchdog;

    expect(requests.map(({ command }) => command)).toEqual(["status", "start"]);
    expect(controller.snapshot().state).toBe("recording");
    expect(alerts.at(-1)).toBe("Recording");
  });

  it("surfaces result errors and logs salvage paths", async () => {
    const harness = makeHarness([
      ok({ sessionId: "s1" }),
      ok({ sessionId: "s1", pendingCount: 1 }),
      ok({
        pendingCount: 0,
        resultAvailable: true,
        result: result({ text: "", errorMessage: "model crashed", salvagePath: "/salvage/s1" }),
      }),
    ]);
    await harness.controller.startRecording();
    await harness.controller.stopRecording(false);
    await harness.controller.pollForResults();

    expect(harness.alerts.at(-1)).toBe("model crashed");
    expect(harness.logErrors).toContain("dictation error: model crashed");
    expect(harness.logInfo).toContain("dictation salvage: /salvage/s1");
    expect(harness.controller.snapshot().polling).toBe(false);
  });

  it("normalizes and pastes successful results", async () => {
    const harness = makeHarness([
      ok({ sessionId: "s1" }),
      ok({ sessionId: "s1", pendingCount: 1 }),
      ok({
        pendingCount: 0,
        resultAvailable: true,
        result: result({ text: "  hello , world  " }),
      }),
    ]);
    await harness.controller.startRecording();
    await harness.controller.stopRecording(false);
    await harness.controller.pollForResults();

    expect(harness.pasteEngine.pastes).toEqual([{ text: "hello, world" }]);
    expect(harness.alerts.at(-1)).toBe("Transcript Ready");
  });

  it("bookkeeps an in-window replacement target for robust retry", async () => {
    const harness = makeHarness([
      ok({ sessionId: "s1" }),
      ok({ sessionId: "s1", pendingCount: 1 }),
      ok({
        pendingCount: 0,
        resultAvailable: true,
        result: result({ text: "first" }),
      }),
      ok({ sessionId: "s2", pendingCount: 1 }),
      ok({
        pendingCount: 0,
        resultAvailable: true,
        result: result({
          sessionId: "s2",
          text: "second",
          metrics: { ...metrics("s2"), transcriptionProfile: "robust" },
        }),
      }),
    ]);
    await harness.controller.startRecording();
    await harness.controller.stopRecording(false);
    await harness.controller.pollForResults();
    harness.scheduler.now += 10;
    await harness.controller.retryRobustTranscription();
    await harness.controller.pollForResults();

    expect(harness.alerts).toContain("Retrying, Will Replace");
    expect(harness.pasteEngine.pastes[1]?.target).toMatchObject({
      originalSessionId: "s1",
      appIdentity: "com.example.Editor",
    });
  });

  it("does not replace after the replacement window expires", async () => {
    const harness = makeHarness([
      ok({ sessionId: "s1" }),
      ok({ sessionId: "s1", pendingCount: 1 }),
      ok({ pendingCount: 0, resultAvailable: true, result: result({ text: "first" }) }),
      ok({ sessionId: "s2", pendingCount: 1 }),
    ]);
    await harness.controller.startRecording();
    await harness.controller.stopRecording(false);
    await harness.controller.pollForResults();
    harness.scheduler.now += 16;
    await harness.controller.retryRobustTranscription();

    expect(harness.alerts).toContain("Retrying Last Audio");
  });

  it("surfaces poller and paste failures without dropping pending state", async () => {
    const pollHarness = makeHarness([
      ok({ sessionId: "s1" }),
      ok({ sessionId: "s1", pendingCount: 1 }),
      new Error("socket refused"),
    ]);
    await pollHarness.controller.startRecording();
    await pollHarness.controller.stopRecording(false);
    await pollHarness.controller.pollForResults();
    expect(pollHarness.alerts.at(-1)).toBe("socket refused");
    expect(pollHarness.controller.snapshot()).toMatchObject({ pendingCount: 1, polling: true });

    const pasteHarness = makeHarness([
      ok({ sessionId: "s2" }),
      ok({ sessionId: "s2", pendingCount: 1 }),
      ok({ pendingCount: 0, resultAvailable: true, result: result({ sessionId: "s2" }) }),
    ]);
    pasteHarness.pasteEngine.failure = new Error("Accessibility denied");
    await pasteHarness.controller.startRecording();
    await pasteHarness.controller.stopRecording(false);
    await pasteHarness.controller.pollForResults();
    expect(pasteHarness.alerts.at(-1)).toBe("Accessibility denied");
  });

  it("reports a detached poll rejection instead of leaking it", async () => {
    const harness = makeHarness([
      ok({ sessionId: "s1" }),
      ok({ sessionId: "s1", pendingCount: 1 }),
      new Error("socket refused"),
    ]);
    await harness.controller.startRecording();
    await harness.controller.stopRecording(false);
    harness.setAlertFailure(new Error("alert renderer failed"));
    for (const callback of harness.scheduler.callbacks.values()) {
      callback();
    }
    await flushPromises();
    await flushPromises();
    expect(harness.logErrors).toContain(
      "dictation poll callback error: alert renderer failed",
    );
    expect(harness.logErrors).toContain(
      "dictation poll callback error alert error: alert renderer failed",
    );
  });

  it("throttles exact health warnings for 300 seconds", async () => {
    const unhealthy = status({
      engineReady: false,
      engineHealthMessage: "capture-buffer-stale",
    });
    const harness = makeHarness([
      ok({ status: unhealthy }),
      ok({ status: unhealthy }),
      ok({ status: unhealthy }),
    ]);
    await harness.controller.watchDaemonStatus();
    harness.scheduler.now += 299;
    await harness.controller.watchDaemonStatus();
    harness.scheduler.now += 1;
    await harness.controller.watchDaemonStatus();
    expect(harness.alerts).toEqual(["Audio Input Stalled", "Audio Input Stalled"]);
  });
});

function makeHarness(responses: Array<ControlResponse | Error>) {
  const requests: ControlRequest[] = [];
  const alerts: string[] = [];
  const recordingProfiles: TranscriptionProfile[] = [];
  const scheduler = new FakeScheduler();
  const pasteEngine = new FakePasteEngine();
  const logErrors: string[] = [];
  const logInfo: string[] = [];
  let hiddenCount = 0;
  let hideFailure: Error | null = null;
  let alertFailure: Error | null = null;
  const controlClient: ControlClient = {
    async send(request) {
      requests.push(request);
      const response = responses.shift();
      if (response instanceof Error) {
        throw response;
      }
      if (!response) {
        throw new Error(`Unexpected ${request.command} request`);
      }
      return response;
    },
  };
  const logger: Logger = {
    error(message) {
      logErrors.push(message);
    },
    info(message) {
      logInfo.push(message);
    },
  };
  const controller = new DictationController({
    controlClient,
    alerts: {
      showAlert: (message) => {
        if (alertFailure) {
          throw alertFailure;
        }
        alerts.push(message);
      },
    },
    overlay: {
      showRecording: (profile) => {
        recordingProfiles.push(profile);
      },
      hideRecording: () => {
        if (hideFailure) {
          throw hideFailure;
        }
        hiddenCount += 1;
      },
    },
    pasteEngine,
    scheduler,
    logger,
  });
  return {
    controller,
    requests,
    alerts,
    recordingProfiles,
    scheduler,
    pasteEngine,
    logErrors,
    logInfo,
    get hiddenCount() {
      return hiddenCount;
    },
    setHideFailure(error: Error | null) {
      hideFailure = error;
    },
    setAlertFailure(error: Error | null) {
      alertFailure = error;
    },
  };
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function ok(overrides: Partial<ControlResponse> = {}): ControlResponse {
  return { ok: true, ...overrides };
}

function status(overrides: Partial<StatusPayload> = {}): StatusPayload {
  return {
    recording: false,
    pendingCount: 0,
    engineReady: true,
    prebufferAvailableMilliseconds: 1_000,
    serverState: "ready",
    ...overrides,
  };
}

function metrics(sessionId = "s1") {
  return {
    sessionId,
    transcriptionProfile: "fast",
    prebufferMilliseconds: 1_000,
    audioDurationMilliseconds: 2_000,
  };
}

function result(overrides: Partial<SessionResultPayload> = {}): SessionResultPayload {
  return {
    sessionId: "s1",
    text: "hello",
    metrics: metrics(),
    ...overrides,
  };
}
