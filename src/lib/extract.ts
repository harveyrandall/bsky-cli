const URL_PATTERN = /https?:\/\/[-A-Za-z0-9+&@#/%?=~_|!:,.;()]+/g;
const MENTION_PATTERN = /@[a-zA-Z0-9.]+/g;
const TAG_PATTERN = /\B#\S+/g;

export interface TextEntry {
  start: number;
  end: number;
  text: string;
}

function byteLength(str: string): number {
  return new TextEncoder().encode(str).byteLength;
}

function extractWithByteOffsets(
  text: string,
  pattern: RegExp,
  stripPrefix?: string,
): TextEntry[] {
  const results: TextEntry[] = [];
  let match: RegExpExecArray | null;

  // Reset lastIndex for global regex
  pattern.lastIndex = 0;

  while ((match = pattern.exec(text)) !== null) {
    const before = text.slice(0, match.index);
    const matchText = match[0];
    const start = byteLength(before);
    const end = start + byteLength(matchText);
    const entryText = stripPrefix
      ? matchText.replace(new RegExp(`^${stripPrefix}`), "")
      : matchText;

    results.push({ start, end, text: entryText });
  }

  return results;
}

export function extractLinks(text: string): TextEntry[] {
  return extractWithByteOffsets(text, URL_PATTERN);
}

export function extractMentions(text: string): TextEntry[] {
  return extractWithByteOffsets(text, MENTION_PATTERN, "@");
}

export function extractTags(text: string): TextEntry[] {
  return extractWithByteOffsets(text, TAG_PATTERN, "#");
}
