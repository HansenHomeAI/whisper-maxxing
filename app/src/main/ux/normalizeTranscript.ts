const WHOLE_STRING_MARKERS = new Set(["BLANKAUDIO", "NOSPEECH", "SILENCE"]);
const LUA_WHITESPACE_AT_START = /^[\f\n\r\t\v ]+/;
const LUA_WHITESPACE_AT_END = /[\f\n\r\t\v ]+$/;
const PLACEHOLDER_PATTERNS = [
  /\[\s*BLANK[_ -]AUDIO\s*\]/g,
  /\(\s*BLANK[_ -]AUDIO\s*\)/g,
  /\[\s*NO[_ -]SPEECH\s*\]/g,
  /\(\s*NO[_ -]SPEECH\s*\)/g,
  /\[\s*NOSPEECH\s*\]/g,
  /\(\s*NOSPEECH\s*\)/g,
  /\[\s*SILENCE\s*\]/g,
  /\(\s*SILENCE\s*\)/g,
] as const;

export function normalizeTranscript(text: string | null | undefined): string | null {
  if (text === null || text === undefined) {
    return null;
  }

  const trimmed = text
    .replace(LUA_WHITESPACE_AT_START, "")
    .replace(LUA_WHITESPACE_AT_END, "");
  if (trimmed.length === 0) {
    return null;
  }

  const marker = trimmed
    .toUpperCase()
    .replace(/[\f\n\r\t\v _-]/g, "")
    .replace(/[\[\]()]+/g, "");
  if (WHOLE_STRING_MARKERS.has(marker)) {
    return null;
  }

  let cleaned = trimmed;
  for (const pattern of PLACEHOLDER_PATTERNS) {
    cleaned = cleaned.replace(pattern, " ");
  }

  const lines = cleaned
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/[ \t][ \t]+/g, " ")
        .replace(LUA_WHITESPACE_AT_START, "")
        .replace(LUA_WHITESPACE_AT_END, "")
        .replace(/[\f\n\r\t\v ]+([,.!?;:])/g, "$1"),
    )
    .filter((line) => line.length > 0);
  cleaned = lines.join("\n");

  return cleaned.length > 0 && /[A-Za-z0-9]/.test(cleaned) ? cleaned : null;
}
