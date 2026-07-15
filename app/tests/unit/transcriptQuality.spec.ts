import { describe, expect, it } from "vitest";

import { assessTranscriptQuality } from "../../src/core/transcriptQuality.js";

describe("TranscriptQuality Unicode parity", () => {
  it("counts extended graphemes like Swift String", () => {
    const assessment = assessTranscriptQuality("😀".repeat(18), 8_000);

    expect(assessment.characterCount).toBe(18);
    expect(assessment.requiresSecondPass).toBe(true);
    expect(assessment.reason).toBe("long-audio-short-transcript");
  });

  it("counts a joined emoji sequence as one character", () => {
    const assessment = assessTranscriptQuality("👨‍👩‍👧‍👦", 1_000);

    expect(assessment.characterCount).toBe(1);
  });

  it("trims Unicode NEL exactly like Foundation", () => {
    const assessment = assessTranscriptQuality("\u0085".repeat(35), 8_000);

    expect(assessment.characterCount).toBe(0);
    expect(assessment.requiresSecondPass).toBe(false);
    expect(assessment.reason).toBeNull();
  });
});
