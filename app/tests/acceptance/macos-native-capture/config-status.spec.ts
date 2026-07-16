import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseAppConfig } from "../../../src/core/appConfig.js";
import { decodeControlResponse } from "../../../src/core/controlProtocol.js";

const fixture = JSON.parse(readFileSync(
  path.resolve(import.meta.dirname, "../../../../docs/electron-port/acceptance/parity-cases.json"),
  "utf8",
)) as {
  appConfig: { cases: Array<{ config?: Record<string, unknown> }> };
};
const legacy = fixture.appConfig.cases.find((entry) => entry.config !== undefined)?.config;
if (legacy === undefined) {
  throw new Error("Missing legacy config fixture");
}

describe("native capture config and status", () => {
  it("defaults legacy configs to native macOS capture", () => {
    expect(parseAppConfig(legacy).macCaptureBackend).toBe("native");
  });

  it("accepts only the two explicit macOS backend values", () => {
    expect(parseAppConfig({ ...legacy, macCaptureBackend: "native" }).macCaptureBackend)
      .toBe("native");
    expect(parseAppConfig({ ...legacy, macCaptureBackend: "electron" }).macCaptureBackend)
      .toBe("electron");
    expect(() => parseAppConfig({ ...legacy, macCaptureBackend: "automatic" })).toThrow();
  });

  it("decodes the additive backend status field", () => {
    const response = decodeControlResponse({
      ok: true,
      status: {
        recording: false,
        pendingCount: 0,
        engineReady: true,
        prebufferAvailableMilliseconds: 1_000,
        serverState: "ready",
        captureBackend: "native-macos",
      },
    });
    expect(response.status?.captureBackend).toBe("native-macos");
    expect(() => decodeControlResponse({
      ok: true,
      status: {
        recording: false,
        pendingCount: 0,
        engineReady: true,
        prebufferAvailableMilliseconds: 1_000,
        serverState: "ready",
        captureBackend: "fake",
      },
    })).toThrow();
  });
});
