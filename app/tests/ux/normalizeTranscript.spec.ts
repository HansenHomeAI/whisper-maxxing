import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { normalizeTranscript } from "../../src/main/ux/normalizeTranscript.js";

interface Fixture {
  cases: Array<{ name: string; input: string; expect: string | null }>;
}

describe("normalizeTranscript", () => {
  it("executes every immutable acceptance case", async () => {
    const fixture = JSON.parse(
      await readFile("../docs/electron-port/acceptance/normalize-transcript-cases.json", "utf8"),
    ) as Fixture;
    let executedCaseCount = 0;
    for (const testCase of fixture.cases) {
      expect(normalizeTranscript(testCase.input), testCase.name).toBe(testCase.expect);
      executedCaseCount += 1;
    }
    expect(executedCaseCount).toBe(fixture.cases.length);
  });

  it("keeps placeholder stripping case-sensitive", () => {
    expect(normalizeTranscript("[blank_audio] real words")).toBe("[blank_audio] real words");
  });
});
