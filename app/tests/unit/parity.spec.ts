import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  appPaths,
  assessCaptureIntegrity,
  assessCaptureReadiness,
  assessCaptureRestart,
  assessTranscriptQuality,
  decodeControlRequest,
  isLoopbackControlHost,
  parseAppConfig,
  SessionResultBuffer,
  type SessionResultPayload,
} from "../../src/core/index.js";

interface ExpectedReason {
  reason: string | null;
}

interface ParityFixture {
  transcriptQuality: {
    cases: Array<{
      name: string;
      text?: string;
      textRepeat?: { unit: string; count: number; separator: string };
      audioDurationMilliseconds: number;
      expect: ExpectedReason & { requiresSecondPass: boolean };
    }>;
  };
  captureIntegrity: {
    cases: Array<{
      name: string;
      capturedAudioMilliseconds: number;
      prebufferMilliseconds: number;
      captureWallClockMilliseconds: number;
      expect: ExpectedReason & { requiresFailure: boolean };
    }>;
  };
  captureReadiness: {
    cases: Array<{
      name: string;
      engineRunning: boolean;
      startupSignaled: boolean;
      secondsSinceLastBuffer: number | null;
      expect: ExpectedReason & { ready: boolean };
    }>;
  };
  captureRestartPolicy: {
    cases: Array<{
      name: string;
      consecutiveFailureCount: number;
      expect: { action: string; reason: string };
    }>;
  };
  sessionResultBuffer: {
    cases: Array<{
      name: string;
      ops: Array<{
        op: "append" | "popNext" | "count";
        sessionId?: string;
        text?: string;
        expectSessionId?: string;
        expectText?: string;
        expectNull?: boolean;
        expect?: number;
      }>;
    }>;
  };
  appConfig: {
    cases: Array<{
      name: string;
      config?: Record<string, unknown>;
      configDelta?: Record<string, unknown>;
      hosts?: string[];
      expect: Record<string, unknown>;
    }>;
  };
  controlProtocol: {
    cases: Array<{
      name: string;
      request: Record<string, unknown>;
      expect: Record<string, unknown>;
    }>;
  };
}

const fixturePath = new URL(
  "../../../docs/electron-port/acceptance/parity-cases.json",
  import.meta.url,
);
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as ParityFixture;
const allSections = [
  fixture.transcriptQuality,
  fixture.captureIntegrity,
  fixture.captureReadiness,
  fixture.captureRestartPolicy,
  fixture.sessionResultBuffer,
  fixture.appConfig,
  fixture.controlProtocol,
];
const totalCaseCount = allSections.reduce(
  (count, section) => count + section.cases.length,
  0,
);
let executedCaseCount = 0;

describe("Swift core parity fixture", () => {
  for (const testCase of fixture.transcriptQuality.cases) {
    it(testCase.name, () => {
      executedCaseCount += 1;
      const text =
        testCase.text ??
        Array.from(
          { length: testCase.textRepeat?.count ?? 0 },
          () => testCase.textRepeat?.unit ?? "",
        ).join(testCase.textRepeat?.separator ?? "");
      const assessment = assessTranscriptQuality(
        text,
        testCase.audioDurationMilliseconds,
      );
      expect(assessment.requiresSecondPass).toBe(
        testCase.expect.requiresSecondPass,
      );
      expect(assessment.reason).toBe(testCase.expect.reason);
    });
  }

  for (const testCase of fixture.captureIntegrity.cases) {
    it(testCase.name, () => {
      executedCaseCount += 1;
      const assessment = assessCaptureIntegrity(
        testCase.capturedAudioMilliseconds,
        testCase.prebufferMilliseconds,
        testCase.captureWallClockMilliseconds,
      );
      expect(assessment.requiresFailure).toBe(testCase.expect.requiresFailure);
      expect(assessment.reason).toBe(testCase.expect.reason);
    });
  }

  for (const testCase of fixture.captureReadiness.cases) {
    it(testCase.name, () => {
      executedCaseCount += 1;
      const assessment = assessCaptureReadiness(
        testCase.engineRunning,
        testCase.startupSignaled,
        testCase.secondsSinceLastBuffer,
      );
      expect(assessment.ready).toBe(testCase.expect.ready);
      expect(assessment.reason).toBe(testCase.expect.reason);
    });
  }

  for (const testCase of fixture.captureRestartPolicy.cases) {
    it(testCase.name, () => {
      executedCaseCount += 1;
      const decision = assessCaptureRestart(testCase.consecutiveFailureCount);
      expect(decision.action).toBe(testCase.expect.action);
      expect(decision.reason).toBe(testCase.expect.reason);
    });
  }

  for (const testCase of fixture.sessionResultBuffer.cases) {
    it(testCase.name, () => {
      executedCaseCount += 1;
      const buffer = new SessionResultBuffer();
      for (const operation of testCase.ops) {
        if (operation.op === "append") {
          buffer.append(makeResult(operation.sessionId ?? "", operation.text ?? ""));
        } else if (operation.op === "popNext") {
          const result = buffer.popNext(operation.sessionId);
          if (operation.expectNull === true) {
            expect(result).toBeNull();
          } else {
            expect(result?.sessionId).toBe(operation.expectSessionId);
            expect(result?.text).toBe(operation.expectText);
          }
        } else {
          expect(buffer.count()).toBe(operation.expect);
        }
      }
    });
  }

  const baseConfigCase = fixture.appConfig.cases.find(
    (testCase) => testCase.config !== undefined,
  );
  if (baseConfigCase?.config === undefined) {
    throw new Error("Parity fixture does not contain a base app config.");
  }
  const baseConfig = baseConfigCase.config;

  for (const testCase of fixture.appConfig.cases) {
    it(testCase.name, () => {
      executedCaseCount += 1;
      if (testCase.hosts !== undefined) {
        for (const host of testCase.hosts) {
          expect(isLoopbackControlHost(host)).toBe(testCase.expect.isLoopback);
        }
        return;
      }

      const configInput = {
        ...(testCase.config ?? baseConfig),
        ...(testCase.configDelta ?? {}),
      };
      if (testCase.expect.throws === true) {
        expect(() => parseAppConfig(configInput)).toThrow();
        return;
      }

      const config = parseAppConfig(configInput);
      for (const [field, expected] of Object.entries(testCase.expect)) {
        if (field === "robustWhisperServerLogFilename") {
          const actual = appPaths(config).robustWhisperServerLogPath;
          expect(actual.split(/[\\/]/u).at(-1)).toBe(expected);
        } else {
          expect(config[field as keyof typeof config]).toEqual(expected);
        }
      }
    });
  }

  it("keeps legacy idle capture and accepts on-demand privacy mode", () => {
    expect(parseAppConfig(baseConfig).captureWhileIdle).toBe(true);
    expect(
      parseAppConfig({ ...baseConfig, captureWhileIdle: false })
        .captureWhileIdle,
    ).toBe(false);
  });

  for (const testCase of fixture.controlProtocol.cases) {
    it(testCase.name, () => {
      executedCaseCount += 1;
      const roundTripped = JSON.parse(JSON.stringify(testCase.request)) as unknown;
      expect(decodeControlRequest(roundTripped)).toEqual(testCase.expect);
    });
  }

  it("executes every immutable fixture case", () => {
    expect(executedCaseCount).toBe(totalCaseCount);
  });
});

function makeResult(sessionId: string, text: string): SessionResultPayload {
  return {
    sessionId,
    text,
    metrics: {
      sessionId,
      prebufferMilliseconds: 0,
      audioDurationMilliseconds: 100,
      transcriptionMode: "test",
      transcriptionMilliseconds: 1,
      queueWaitMilliseconds: 0,
      completedAtISO8601: null,
    },
    salvagePath: null,
    errorMessage: null,
  };
}
