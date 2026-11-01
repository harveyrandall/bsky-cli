import { stripVTControlCharacters } from "node:util";

/** Composer text state. `cursor` is a UTF-16 offset on a grapheme boundary. */
export interface EditorState {
  text: string;
  cursor: number;
  history: string[];
  /** Entry being shown while walking history, or null when editing. */
  historyIndex: number | null;
  /** Text the user had typed before walking history. */
  draft: string;
}

export function emptyEditor(history: string[] = []): EditorState {
  return { text: "", cursor: 0, history, historyIndex: null, draft: "" };
}

export type EditorAction =
  | { type: "insert"; text: string }
  | { type: "set"; text: string }
  | { type: "newline" }
  | { type: "continueLine" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "left" }
  | { type: "right" }
  | { type: "up" }
  | { type: "down" }
  | { type: "lineStart" }
  | { type: "lineEnd" }
  | { type: "wordLeft" }
  | { type: "wordRight" }
  | { type: "deleteWord" }
  | { type: "deleteToLineStart" }
  | { type: "clear" }
  | { type: "submitted" };

const segmenter = new Intl.Segmenter();

/** CR/CRLF become \n; escape sequences and control bytes other than \n and \t go. */
const clean = (text: string) =>
  stripVTControlCharacters(text.replace(/\r\n?/g, "\n")).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
const graphemes = (text: string) => [...segmenter.segment(text)];

function prevBoundary(text: string, i: number): number {
  let prev = 0;
  for (const { index } of segmenter.segment(text)) {
    if (index >= i) break;
    prev = index;
  }
  return prev;
}

function nextBoundary(text: string, i: number): number {
  for (const { index, segment } of segmenter.segment(text)) {
    if (index >= i) return index + segment.length;
  }
  return text.length;
}

const lineStart = (text: string, i: number) => (i === 0 ? 0 : text.lastIndexOf("\n", i - 1) + 1);
const lineEnd = (text: string, i: number) => {
  const nl = text.indexOf("\n", i);
  return nl < 0 ? text.length : nl;
};

/** Offset of grapheme column `col` in text[start, end), clamped to `end`. */
function atColumn(text: string, start: number, end: number, col: number): number {
  const line = graphemes(text.slice(start, end));
  return col >= line.length ? end : start + line[col].index;
}

const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);

function wordLeft(text: string, i: number): number {
  while (i > 0 && isSpace(text[i - 1])) i--;
  while (i > 0 && !isSpace(text[i - 1])) i--;
  return i;
}

function wordRight(text: string, i: number): number {
  while (i < text.length && isSpace(text[i])) i++;
  while (i < text.length && !isSpace(text[i])) i++;
  return i;
}

const splice = (s: EditorState, from: number, to: number, insert = ""): EditorState => ({
  ...s,
  text: s.text.slice(0, from) + insert + s.text.slice(to),
  cursor: from + insert.length,
});

const show = (s: EditorState, text: string, historyIndex: number | null): EditorState => ({
  ...s,
  text,
  cursor: text.length,
  historyIndex,
});

function up(s: EditorState): EditorState {
  const start = lineStart(s.text, s.cursor);
  if (start > 0) {
    const col = graphemes(s.text.slice(start, s.cursor)).length;
    return { ...s, cursor: atColumn(s.text, lineStart(s.text, start - 1), start - 1, col) };
  }
  if (s.history.length === 0) return s;
  if (s.historyIndex === null) {
    return { ...show(s, s.history[s.history.length - 1], s.history.length - 1), draft: s.text };
  }
  const index = Math.max(0, s.historyIndex - 1);
  return show(s, s.history[index], index);
}

function down(s: EditorState): EditorState {
  const end = lineEnd(s.text, s.cursor);
  if (end < s.text.length) {
    const col = graphemes(s.text.slice(lineStart(s.text, s.cursor), s.cursor)).length;
    return { ...s, cursor: atColumn(s.text, end + 1, lineEnd(s.text, end + 1), col) };
  }
  if (s.historyIndex === null) return s;
  if (s.historyIndex === s.history.length - 1) return show(s, s.draft, null);
  return show(s, s.history[s.historyIndex + 1], s.historyIndex + 1);
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  if (action.type === "up") return up(state);
  if (action.type === "down") return down(state);

  // Anything but up/down leaves history mode.
  const s = { ...state, historyIndex: null };
  const { text, cursor } = s;
  switch (action.type) {
    case "insert":
      return splice(s, cursor, cursor, clean(action.text));
    case "set":
      return { ...s, text: action.text, cursor: action.text.length };
    case "newline":
      return splice(s, cursor, cursor, "\n");
    case "continueLine":
      return splice(s, cursor - 1, cursor, "\n");
    case "backspace":
      return splice(s, prevBoundary(text, cursor), cursor);
    case "delete":
      return splice(s, cursor, nextBoundary(text, cursor));
    case "left":
      return { ...s, cursor: prevBoundary(text, cursor) };
    case "right":
      return { ...s, cursor: nextBoundary(text, cursor) };
    case "lineStart":
      return { ...s, cursor: lineStart(text, cursor) };
    case "lineEnd":
      return { ...s, cursor: lineEnd(text, cursor) };
    case "wordLeft":
      return { ...s, cursor: wordLeft(text, cursor) };
    case "wordRight":
      return { ...s, cursor: wordRight(text, cursor) };
    case "deleteWord":
      return splice(s, wordLeft(text, cursor), cursor);
    case "deleteToLineStart":
      return splice(s, lineStart(text, cursor), cursor);
    case "clear":
      return { ...s, text: "", cursor: 0 };
    case "submitted": {
      // Blank input stays out of history so Up never recalls an empty entry.
      const keep = text.trim() !== "" && s.history[s.history.length - 1] !== text;
      return emptyEditor(keep ? [...s.history, text] : s.history);
    }
  }
}
