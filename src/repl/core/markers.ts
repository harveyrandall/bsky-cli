import { graphemeLength, splitThread } from "@/lib/split-thread";

export interface Markers {
  readonly split: string;
  readonly send: string;
  readonly cut: string;
}

export const DEFAULT_MARKERS: Markers = Object.freeze({ split: "///", send: "//>", cut: "<//" });

type Kind = keyof Markers;

/** UTF-16 offsets of one marker occurrence. */
export interface MarkerHit {
  kind: Kind;
  start: number;
  end: number;
}

/** The segment under the cursor: a numbered piece to send, or kept/cut text. */
export type Segment =
  | { region: "send"; /** 1-based */ index: number; total: number; text: string }
  | { region: "kept" | "cut"; text: string };

const CONFIG_KEYS: [Kind, "splitMarker" | "sendMarker" | "cutMarker", string][] = [
  ["split", "splitMarker", "split-marker"],
  ["send", "sendMarker", "send-marker"],
  ["cut", "cutMarker", "cut-marker"],
];

/** The marker rule `value` breaks, if any. */
export function brokenRule(value: unknown, seen: string[]): string | undefined {
  if (typeof value !== "string") return "markers must be text";
  if (value === "") return "markers can't be empty";
  if (/\s/.test(value)) return "markers can't contain spaces";
  if (/^\/[a-z]/.test(value)) return "markers can't start with / and a letter, which begins a command";
  if (seen.includes(value)) return "markers must differ from each other";
}

export function resolveMarkers(opts: {
  splitMarker?: unknown;
  sendMarker?: unknown;
  cutMarker?: unknown;
}): Markers {
  const markers: Record<Kind, string> = { ...DEFAULT_MARKERS };
  const seen: string[] = [];
  for (const [kind, opt, key] of CONFIG_KEYS) {
    const value = opts[opt] ?? markers[kind];
    const broken = brokenRule(value, seen);
    if (broken) throw new Error(`Invalid [repl] ${key} = ${JSON.stringify(value)}: ${broken}`);
    markers[kind] = value as string;
    seen.push(value as string);
  }
  return markers;
}

/** The marker starting at `i`, longest first. */
function markerAt(text: string, i: number, m: Markers): Kind | undefined {
  return (["split", "send", "cut"] as const)
    .filter((k) => m[k] !== "" && text.startsWith(m[k], i))
    .sort((a, b) => m[b].length - m[a].length)[0];
}

/** Markers in order; a `\` directly before a marker escapes it. */
export function scanMarkers(text: string, m: Markers): MarkerHit[] {
  const hits: MarkerHit[] = [];
  let i = 0;
  while (i < text.length) {
    const escaped = text[i] === "\\" ? markerAt(text, i + 1, m) : undefined;
    if (escaped) {
      i += 1 + m[escaped].length;
      continue;
    }
    const kind = markerAt(text, i, m);
    if (kind) {
      hits.push({ kind, start: i, end: i + m[kind].length });
      i += m[kind].length;
    } else {
      i++;
    }
  }
  return hits;
}

function unescape(text: string, m: Markers): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && markerAt(text, i + 1, m)) continue;
    out += text[i];
  }
  return out;
}

/** The reverse of `unescape`: every marker in `text` becomes plain text. */
export function escapeMarkers(text: string, m: Markers): string {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const kind = markerAt(text, i, m);
    out += kind ? `\\${m[kind]}` : text[i];
    i += kind ? m[kind].length : 1;
  }
  return out;
}

/**
 * The segment the cursor is in. Text after the first send marker is kept. Text
 * after the first cut marker before it (up to the send marker) is cut. The rest
 * splits into numbered pieces at split markers; split markers inside cut or
 * kept text are ignored. A cursor at a marker's end belongs to what follows it.
 */
export function segmentAt(text: string, cursor: number, m: Markers): Segment {
  const hits = scanMarkers(text, m);
  const send = hits.find((h) => h.kind === "send");
  const sendStart = send?.start ?? text.length;
  const cut = hits.find((h) => h.kind === "cut" && h.start < sendStart);
  const piecesEnd = cut?.start ?? sendStart;
  const splits = hits.filter((h) => h.kind === "split" && h.end <= piecesEnd);
  const total = splits.length + 1;
  const clean = (start: number, end: number) => unescape(text.slice(start, end), m).trim();

  if (send && cursor >= send.end) {
    return { region: "kept", text: clean(send.end, text.length) };
  }
  if (cut && cursor >= cut.end) {
    return { region: "cut", text: clean(cut.end, sendStart) };
  }
  const before = splits.filter((h) => h.end <= cursor).length;
  const start = before === 0 ? 0 : splits[before - 1].end;
  const end = before < splits.length ? splits[before].start : piecesEnd;
  return { region: "send", index: before + 1, total, text: clean(start, end) };
}

export interface SubmitPlan {
  /** Trimmed, empty pieces dropped. */
  posts: string[];
  /** The text being sent, before splitting (for trim hints). */
  source: string;
  /** Text after the first send marker, as typed, for the composer. */
  keep?: string;
  /** Text after the first cut marker in the send part. */
  discard?: string;
  /** No split markers and the text was over the limit. */
  autoSplit: boolean;
  markersUsed: boolean;
  /** Indexes of marker-made posts longer than the limit. */
  overLimit: number[];
}

/**
 * What submitting `text` sends (spec §7): up to the first send marker, minus
 * anything after a cut marker, split at split markers. Long text with no split
 * markers is split automatically to fit `limit`.
 */
export function parseSubmit(text: string, m: Markers, limit: number): SubmitPlan {
  const hits = scanMarkers(text, m);
  const send = hits.find((h) => h.kind === "send");
  const sendStart = send?.start ?? text.length;
  const cut = hits.find((h) => h.kind === "cut" && h.start < sendStart);
  const piecesEnd = cut?.start ?? sendStart;
  const splits = hits.filter((h) => h.kind === "split" && h.end <= piecesEnd);

  const keep = send ? text.slice(send.end).replace(/^\s+/, "") : "";
  const discard = cut ? unescape(text.slice(cut.end, sendStart), m).trim() : "";
  const bounds = [0, ...splits.flatMap((h) => [h.start, h.end]), piecesEnd];
  const pieces: string[] = [];
  for (let i = 0; i < bounds.length; i += 2) pieces.push(unescape(text.slice(bounds[i], bounds[i + 1]), m).trim());
  let posts = pieces.filter((p) => p !== "");

  const autoSplit = splits.length === 0 && posts.length === 1 && graphemeLength(posts[0]) > limit;
  if (autoSplit) {
    posts = splitThread(posts[0], { splitMarker: false, maxChars: limit, threadLabel: false }).map((p) => p.text);
  }
  const overLimit = splits.length === 0 ? [] : posts.flatMap((p, i) => (graphemeLength(p) > limit ? [i] : []));
  return {
    posts,
    source: unescape(text.slice(0, piecesEnd), m).trim(),
    ...(keep && { keep }),
    ...(discard && { discard }),
    autoSplit,
    markersUsed: Boolean(send || cut || splits.length),
    overLimit,
  };
}
