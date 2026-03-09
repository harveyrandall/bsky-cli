import { Segmenter } from "node:util";

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * Count grapheme clusters in a string. Matches Bluesky's 300-grapheme limit.
 */
export function graphemeLength(text: string): number {
  return [...segmenter.segment(text)].length;
}

/**
 * Slice a string by grapheme indices (start inclusive, end exclusive).
 */
function graphemeSlice(text: string, start: number, end?: number): string {
  const segments = [...segmenter.segment(text)];
  return segments
    .slice(start, end)
    .map((s) => s.segment)
    .join("");
}

export interface SplitOptions {
  maxChars: number;
  minLastPostChars: number;
  threadLabel: boolean;
  threadLabelPosition: "append" | "prepend";
}

export interface ThreadPost {
  text: string;
  index: number;
}

const DEFAULT_OPTS: SplitOptions = {
  maxChars: 300,
  minLastPostChars: 75,
  threadLabel: false,
  threadLabelPosition: "append",
};

/**
 * Calculate the grapheme length of a thread label like "🧵 1/5" or "🧵 10/12".
 */
function labelLength(postNum: number, totalPosts: number): number {
  // "🧵 1/5" — emoji(1) + space(1) + digits + slash(1) + digits
  return graphemeLength(`🧵 ${postNum}/${totalPosts}`);
}

/**
 * Find the best split point in text, scanning backwards from maxLen.
 * Returns the grapheme index to split at (exclusive — text[0..splitAt] is the chunk).
 *
 * Priority: sentence boundary > clause boundary > word boundary.
 */
function findSplitPoint(text: string, maxLen: number): number {
  const segments = [...segmenter.segment(text)];
  const chars = segments.map((s) => s.segment);

  // Don't split if text already fits
  if (chars.length <= maxLen) return chars.length;

  // Scan backwards from maxLen to find boundaries
  let sentenceSplit = -1;
  let clauseSplit = -1;
  let wordSplit = -1;

  for (let i = maxLen; i > 0; i--) {
    const ch = chars[i - 1]; // character at position i-1
    const next = chars[i]; // character at position i (would be start of next chunk)

    // Sentence boundary: punctuation followed by space or end
    if ((ch === "." || ch === "?" || ch === "!") && (!next || next === " ")) {
      if (sentenceSplit === -1) sentenceSplit = i;
    }

    // Clause boundary: comma/semicolon/colon/dash followed by space
    if (
      (ch === "," || ch === ";" || ch === ":" || ch === "—") &&
      next === " "
    ) {
      if (clauseSplit === -1) clauseSplit = i;
    }

    // Word boundary: space character
    if (ch === " ") {
      if (wordSplit === -1) wordSplit = i;
    }
  }

  // Return best available split point
  if (sentenceSplit > 0) return sentenceSplit;
  if (clauseSplit > 0) return clauseSplit;
  if (wordSplit > 0) return wordSplit;

  // No boundary found — degenerate case (single word > maxLen)
  throw new Error(
    `Cannot split text: found a word longer than ${maxLen} graphemes`,
  );
}

/**
 * Split text into chunks respecting boundary priorities.
 */
function splitIntoChunks(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();

  while (graphemeLength(remaining) > maxLen) {
    const splitAt = findSplitPoint(remaining, maxLen);
    const chunk = graphemeSlice(remaining, 0, splitAt).trimEnd();
    chunks.push(chunk);
    remaining = graphemeSlice(remaining, splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

/**
 * Redistribute the last two chunks so the final chunk has at least minChars.
 */
function redistributeLastChunk(
  chunks: string[],
  maxLen: number,
  minChars: number,
): string[] {
  if (chunks.length < 2) return chunks;

  const last = chunks[chunks.length - 1];
  if (graphemeLength(last) >= minChars) return chunks;

  // Merge last two chunks and re-split
  const merged =
    chunks[chunks.length - 2] + " " + chunks[chunks.length - 1];
  const result = chunks.slice(0, -2);

  // Find a split point that gives the second half at least minChars
  const mergedLen = graphemeLength(merged);
  const targetFirst = mergedLen - minChars;

  if (targetFirst <= 0 || targetFirst > maxLen) {
    // Can't redistribute cleanly — just merge them if they fit
    if (mergedLen <= maxLen) {
      result.push(merged);
      return result;
    }
    // Otherwise re-split normally
    const reSplit = splitIntoChunks(merged, maxLen);
    result.push(...reSplit);
    return result;
  }

  // Find best boundary at or before targetFirst
  const splitAt = findSplitPoint(merged, Math.min(targetFirst, maxLen));
  const first = graphemeSlice(merged, 0, splitAt).trimEnd();
  const second = graphemeSlice(merged, splitAt).trimStart();

  if (graphemeLength(second) < minChars) {
    // Boundary search didn't help — try splitting the merged text normally
    const reSplit = splitIntoChunks(merged, maxLen);
    result.push(...reSplit);
    return result;
  }

  result.push(first, second);
  return result;
}

/**
 * Split long text into thread posts.
 *
 * Returns an array of ThreadPost objects. If labels are enabled,
 * the label text (e.g. "🧵 1/5") is included in each post's text.
 */
export function splitThread(
  text: string,
  opts?: Partial<SplitOptions>,
): ThreadPost[] {
  const o = { ...DEFAULT_OPTS, ...opts };
  const trimmed = text.trim();

  // Single post — no splitting needed
  if (graphemeLength(trimmed) <= o.maxChars) {
    return [{ text: trimmed, index: 0 }];
  }

  // Iterative splitting to account for label overhead
  let chunks: string[];
  let prevCount = 0;
  let iterations = 0;
  const maxIterations = 5;

  // Start with estimated effective max
  let effectiveMax = o.maxChars;
  if (o.threadLabel) {
    const estimated = Math.ceil(graphemeLength(trimmed) / o.maxChars);
    // Worst-case label: largest post number and total count
    const worstLabel = labelLength(estimated, estimated);
    // +1 for separator (newline or space)
    effectiveMax = o.maxChars - worstLabel - 1;
  }

  chunks = splitIntoChunks(trimmed, effectiveMax);
  chunks = redistributeLastChunk(chunks, effectiveMax, o.minLastPostChars);

  // Iterate until post count stabilises (label length may change digit count)
  while (o.threadLabel && chunks.length !== prevCount && iterations < maxIterations) {
    prevCount = chunks.length;
    const worstLabel = labelLength(chunks.length, chunks.length);
    effectiveMax = o.maxChars - worstLabel - 1;
    chunks = splitIntoChunks(trimmed, effectiveMax);
    chunks = redistributeLastChunk(chunks, effectiveMax, o.minLastPostChars);
    iterations++;
  }

  // Attach labels if enabled
  return chunks.map((chunk, i) => {
    let postText = chunk;
    if (o.threadLabel) {
      const label = `🧵 ${i + 1}/${chunks.length}`;
      if (o.threadLabelPosition === "prepend") {
        postText = `${label}\n${chunk}`;
      } else {
        postText = `${chunk}\n${label}`;
      }
    }
    return { text: postText, index: i };
  });
}

/**
 * Check if text falls in the awkward 301-375 range: too long for one post,
 * too short to split naturally.
 */
export function isEdgeCaseLength(
  text: string,
  maxChars = 300,
  threshold = 375,
): boolean {
  const len = graphemeLength(text.trim());
  return len > maxChars && len <= threshold;
}

/**
 * Generate trim suggestions for text that's slightly over the limit.
 * Finds sentence/clause boundaries near the target and returns
 * human-readable suggestions.
 */
export function trimSuggestions(
  text: string,
  target = 300,
): { preview: string; charsToRemove: number }[] {
  const trimmed = text.trim();
  const len = graphemeLength(trimmed);
  if (len <= target) return [];

  const segments = [...segmenter.segment(trimmed)];
  const chars = segments.map((s) => s.segment);
  const suggestions: { preview: string; charsToRemove: number }[] = [];

  // Scan backwards from target looking for sentence/clause boundaries
  for (let i = target; i > Math.max(target - 100, 50); i--) {
    const ch = chars[i - 1];
    const next = chars[i];

    const isSentence =
      (ch === "." || ch === "?" || ch === "!") && (!next || next === " ");
    const isClause =
      (ch === "," || ch === ";" || ch === ":" || ch === "—") && next === " ";

    if (isSentence || isClause) {
      const preview = graphemeSlice(trimmed, Math.max(0, i - 30), i);
      suggestions.push({
        preview: `...${preview}`,
        charsToRemove: len - i,
      });
      if (suggestions.length >= 3) break;
    }
  }

  return suggestions;
}
