import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { UX_CONTRACT, withPendingCount } from "../../src/main/ux/uxContract.js";

describe("UX acceptance contract", () => {
  it("matches the immutable fixture value-for-value", async () => {
    const fixture = JSON.parse(
      await readFile("../docs/electron-port/acceptance/ux-parity.json", "utf8"),
    ) as unknown;
    expect(UX_CONTRACT).toEqual(fixture);
  });

  it("formats pending suffixes from the fixture", () => {
    expect(withPendingCount(UX_CONTRACT.alerts.processing, 2)).toBe("Processing Audio (2)");
    expect(withPendingCount(UX_CONTRACT.alerts.processing, 0)).toBe("Processing Audio");
  });
});
