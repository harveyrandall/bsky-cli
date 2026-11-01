export interface Markers {
  split: string;
  send: string;
  cut: string;
}

export const DEFAULT_MARKERS: Markers = { split: "///", send: "//>", cut: "<//" };

type Kind = keyof Markers;

/** UTF-16 offsets of one marker occurrence. */
export interface MarkerHit {
  kind: Kind;
  start: number;
  end: number;
}

export interface Segment {
  /** 1-based piece number in the send part; 0 in kept/cut regions. */
  index: number;
  total: number;
  text: string;
  region: "send" | "kept" | "cut";
}

const CONFIG_KEYS: [Kind, "splitMarker" | "sendMarker" | "cutMarker", string][] = [
  ["split", "splitMarker", "split-marker"],
  ["send", "sendMarker", "send-marker"],
  ["cut", "cutMarker", "cut-marker"],
];

export function resolveMarkers(opts: {
  splitMarker?: unknown;
  sendMarker?: unknown;
  cutMarker?: unknown;
}): Markers {
  const markers = { ...DEFAULT_MARKERS };
  const seen: string[] = [];
  for (const [kind, opt, key] of CONFIG_KEYS) {
    const value = opts[opt] ?? markers[kind];
    if (typeof value !== "string" || value === "" || /\s/.test(value) || seen.includes(value)) {
      throw new Error(
        `Invalid [repl] ${key} = ${JSON.stringify(value)}: markers must be non-empty, have no spaces, and differ from each other`,
      );
    }
    markers[kind] = value;
    seen.push(value);
  }
  return markers;
}

/** The marker starting at `i`, longest first. */
function markerAt(text: string, i: number, m: Markers): Kind | undefined {
  return (["split", "send", "cut"] as const)
    .filter((k) => text.startsWith(m[k], i))
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

/**
 * The segment the cursor is in. After the first send marker is kept; from the
 * first cut marker before it is cut; the rest splits into numbered pieces. A
 * cursor at a marker's end belongs to what follows it.
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
    return { index: 0, total, text: clean(send.end, text.length), region: "kept" };
  }
  if (cut && cursor >= cut.end) {
    return { index: 0, total, text: clean(cut.end, sendStart), region: "cut" };
  }
  const before = splits.filter((h) => h.end <= cursor).length;
  const start = before === 0 ? 0 : splits[before - 1].end;
  const end = before < splits.length ? splits[before].start : piecesEnd;
  return { index: before + 1, total, text: clean(start, end), region: "send" };
}
