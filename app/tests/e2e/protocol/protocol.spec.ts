import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type ControlResponse,
  type SessionResult,
  type StatusPayload,
  sendControl,
  sleep,
  targetFromEnvironment,
  waitForEngineReady,
  waitForPendingCount,
  waitForResult,
} from "./controlClient";

const target = targetFromEnvironment();
const ownedSessionIds = new Set<string>();
let retryableResult: SessionResult;

describe.sequential(`control protocol against ${target.target}`, () => {
  beforeAll(async () => {
    const status = await waitForEngineReady(target);
    expect(status.recording).toBe(false);
    expect(status.pendingCount).toBe(0);
  }, target.resultTimeoutMilliseconds);

  afterAll(async () => {
    const statusResponse = await sendControl(target, "status");
    if (statusResponse.status?.recording) {
      await sendControl(target, "cancel");
    }
    for (const sessionId of ownedSessionIds) {
      await sendControl(target, "nextResult", sessionId);
    }
    await waitForPendingCount(target, 0);
  }, target.resultTimeoutMilliseconds);

  test("status exposes the complete wire contract", async () => {
    const response = await sendControl(target, "status");
    expect(response.ok).toBe(true);
    expect(response.status).toBeDefined();
    assertStatusContract(response.status as StatusPayload);
  });

  test("start stop delivers exactly one result with capture metrics", async () => {
    const sessionId = await recordSession();
    const result = await waitForResult(target, sessionId);
    assertResultContract(result, sessionId);
    retryableResult = result;

    const duplicate = await sendControl(target, "nextResult", sessionId);
    expect(duplicate.ok).toBe(true);
    expect(duplicate.resultAvailable).toBe(false);
  }, target.resultTimeoutMilliseconds);

  test("cancel produces no result and drains pending work", async () => {
    const started = await sendControl(target, "start");
    expect(started.ok).toBe(true);
    const sessionId = requireSessionId(started);
    ownedSessionIds.add(sessionId);
    await sleep(Math.min(target.captureMilliseconds, 300));

    const cancelled = await sendControl(target, "cancel");
    expect(cancelled.ok).toBe(true);
    await waitForPendingCount(target, 0);

    const result = await sendControl(target, "nextResult", sessionId);
    expect(result.ok).toBe(true);
    expect(result.resultAvailable).toBe(false);
  }, target.resultTimeoutMilliseconds);

  test("retry robust rejects recording and retranscribes retained audio", async () => {
    expect(retryableResult).toBeDefined();
    const started = await sendControl(target, "start");
    expect(started.ok).toBe(true);
    ownedSessionIds.add(requireSessionId(started));

    const rejected = await sendControl(target, "retryRobust");
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toBe("Stop the current recording before retranscribing it.");
    expect((await sendControl(target, "cancel")).ok).toBe(true);

    const retried = await sendControl(target, "retryRobust");
    expect(retried.ok).toBe(true);
    const retrySessionId = requireSessionId(retried);
    ownedSessionIds.add(retrySessionId);
    const result = await waitForResult(target, retrySessionId);
    assertResultContract(result, retrySessionId);
    expect(result.metrics.transcriptionProfile).toBe("robust");

    const duplicate = await sendControl(target, "nextResult", retrySessionId);
    expect(duplicate.resultAvailable).toBe(false);
  }, target.resultTimeoutMilliseconds);

  test("targeted reads preserve two overlapping queued results", async () => {
    const firstSessionId = await recordSession(false);
    const secondSessionId = await recordSession(false);

    const secondResult = await waitForResult(target, secondSessionId);
    assertResultContract(secondResult, secondSessionId);
    const firstResult = await waitForResult(target, firstSessionId);
    assertResultContract(firstResult, firstSessionId);

    expect((await sendControl(target, "nextResult", firstSessionId)).resultAvailable).toBe(false);
    expect((await sendControl(target, "nextResult", secondSessionId)).resultAvailable).toBe(false);
  }, target.resultTimeoutMilliseconds);

  test("unknown targeted read neither returns nor discards a result", async () => {
    const sessionId = await recordSession(false);
    const unknownSessionId = `unknown-${randomUUID()}`;
    const unknown = await sendControl(target, "nextResult", unknownSessionId);
    expect(unknown.ok).toBe(true);
    expect(unknown.resultAvailable).toBe(false);

    const result = await waitForResult(target, sessionId);
    assertResultContract(result, sessionId);
    expect((await sendControl(target, "nextResult", sessionId)).resultAvailable).toBe(false);
  }, target.resultTimeoutMilliseconds);
});

async function recordSession(waitForCompletion = true): Promise<string> {
  const started = await sendControl(target, "start");
  expect(started.ok, started.error).toBe(true);
  const sessionId = requireSessionId(started);
  ownedSessionIds.add(sessionId);
  await sleep(target.captureMilliseconds);

  const stopped = await sendControl(target, "stop");
  expect(stopped.ok, stopped.error).toBe(true);
  expect(stopped.sessionId).toBe(sessionId);
  expect(stopped.pendingCount).toBeGreaterThanOrEqual(1);
  if (waitForCompletion) {
    await waitForPendingCount(target, 1);
  }
  return sessionId;
}

function requireSessionId(response: ControlResponse): string {
  expect(response.sessionId).toEqual(expect.any(String));
  expect(response.sessionId?.length).toBeGreaterThan(0);
  return response.sessionId as string;
}

function assertStatusContract(status: StatusPayload): void {
  expect(status.recording).toEqual(expect.any(Boolean));
  expectOptionalType(status.recordingProfile, "string");
  expect(status.pendingCount).toEqual(expect.any(Number));
  expect(Number.isInteger(status.pendingCount)).toBe(true);
  expect(status.engineReady).toEqual(expect.any(Boolean));
  expectOptionalType(status.engineHealthMessage, "string");
  expectOptionalType(status.engineStartupMilliseconds, "number");
  expect(status.prebufferAvailableMilliseconds).toEqual(expect.any(Number));
  expect(status.prebufferAvailableMilliseconds).toBeGreaterThanOrEqual(0);
  expectOptionalType(status.preferredInputDevice, "string");
  expectOptionalType(status.defaultInputDevice, "string");
  expect(status.serverState).toEqual(expect.any(String));
  expectOptionalType(status.robustServerState, "string");
  expectOptionalType(status.availableDiskSpaceBytes, "number");
  expectOptionalType(status.lowDiskSpaceMessage, "string");
}

function assertResultContract(result: SessionResult, sessionId: string): void {
  expect(result.sessionId).toBe(sessionId);
  expect(result.text).toEqual(expect.any(String));
  expectOptionalType(result.errorMessage, "string");
  expectOptionalType(result.salvagePath, "string");
  expect(result.metrics.sessionId).toBe(sessionId);
  expect(result.metrics.audioDurationMilliseconds).toBeGreaterThan(0);
  expect(result.metrics.prebufferMilliseconds).toBeGreaterThanOrEqual(0);
  expect(result.metrics.captureWallClockMilliseconds).toEqual(expect.any(Number));
  expect(result.metrics.activeAudioMilliseconds).toEqual(expect.any(Number));
  expect(result.metrics.captureDroppedMilliseconds).toEqual(expect.any(Number));
  expect(result.metrics.captureCoverageRatio).toEqual(expect.any(Number));
  expect(result.metrics.captureCoverageRatio).toBeGreaterThan(0);
  expect(result.metrics.captureCoverageRatio).toBeLessThanOrEqual(1.01);
  expect(result.metrics.transcriptionMode).toEqual(expect.any(String));
  expect(result.metrics.completedAtISO8601).toEqual(expect.any(String));
}

function expectOptionalType(value: unknown, expectedType: "string" | "number"): void {
  if (value !== undefined && value !== null) {
    expect(typeof value).toBe(expectedType);
  }
}
