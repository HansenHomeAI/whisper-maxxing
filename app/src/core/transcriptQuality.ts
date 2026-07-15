export interface TranscriptQualityAssessment {
  audioDurationMilliseconds: number;
  wordCount: number;
  characterCount: number;
  wordsPerSecond: number;
  charactersPerSecond: number;
  requiresSecondPass: boolean;
  reason: "long-audio-short-transcript" | null;
}

const LONG_AUDIO_THRESHOLD_MILLISECONDS = 8_000;
const MINIMUM_WORDS_PER_SECOND = 0.8;
const MINIMUM_CHARACTERS_PER_SECOND = 4.5;
const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});
const swiftWhitespace = /\p{White_Space}/u;
const swiftWhitespaceEdges =
  /^\p{White_Space}+|\p{White_Space}+$/gu;

export function assessTranscriptQuality(
  text: string,
  audioDurationMilliseconds: number,
): TranscriptQualityAssessment {
  const normalized = text.replace(swiftWhitespaceEdges, "");
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const characterCount = Array.from(
    graphemeSegmenter.segment(normalized),
    ({ segment }) => segment,
  ).filter((character) => !swiftWhitespace.test(character)).length;
  const seconds = Math.max(audioDurationMilliseconds / 1_000, 0.001);
  const wordsPerSecond = words.length / seconds;
  const charactersPerSecond = characterCount / seconds;
  const requiresSecondPass =
    audioDurationMilliseconds >= LONG_AUDIO_THRESHOLD_MILLISECONDS &&
    normalized.length > 0 &&
    wordsPerSecond < MINIMUM_WORDS_PER_SECOND &&
    charactersPerSecond < MINIMUM_CHARACTERS_PER_SECOND;

  return {
    audioDurationMilliseconds,
    wordCount: words.length,
    characterCount,
    wordsPerSecond,
    charactersPerSecond,
    requiresSecondPass,
    reason: requiresSecondPass ? "long-audio-short-transcript" : null,
  };
}
