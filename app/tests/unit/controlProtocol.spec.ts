import { describe, expect, it } from "vitest";

import { decodeControlResponse } from "../../src/core/controlProtocol.js";

describe("decodeControlResponse", () => {
  it("rejects malformed top-level optional fields", () => {
    expect(() => decodeControlResponse({ ok: true, pendingCount: "one" })).toThrow(
      "Unable to decode the control response.",
    );
  });

  it("rejects incomplete nested results", () => {
    expect(() =>
      decodeControlResponse({
        ok: true,
        result: {
          sessionId: "recording-a",
          text: "hello",
          metrics: { sessionId: "recording-a" },
        },
      }),
    ).toThrow("Unable to decode the control response.");
  });

  it("rejects malformed nested status payloads", () => {
    expect(() =>
      decodeControlResponse({
        ok: true,
        status: {
          recording: false,
          pendingCount: 0,
          engineReady: "yes",
          prebufferAvailableMilliseconds: 1_000,
          serverState: "ready",
        },
      }),
    ).toThrow("Unable to decode the control response.");
  });

  it("accepts a complete Swift-compatible response", () => {
    const response = {
      ok: true,
      resultAvailable: true,
      result: {
        sessionId: "recording-a",
        text: "hello",
        metrics: {
          sessionId: "recording-a",
          prebufferMilliseconds: 1_000,
          audioDurationMilliseconds: 2_000,
          transcriptionMilliseconds: 100,
        },
        salvagePath: null,
        errorMessage: null,
      },
    };

    expect(decodeControlResponse(response)).toBe(response);
  });
});
