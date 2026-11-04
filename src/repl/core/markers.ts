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
function brokenRule(value: unknown, seen: string[]): string | undefined {
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
