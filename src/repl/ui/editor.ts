import { stripVTControlCharacters } from "node:util";

/** Composer text state. `cursor` is a UTF-16 offset on a grapheme boundary. */
export interface EditorState {
  text: string;
  cursor: number;
  history: string[];
  /** Entry shown while walking history (history.length is the draft), or null when not walking. */
  historyIndex: number | null;
  /** While walking: the history entries plus the draft, with any edits made to them. */
  scratch: string[];
}

export function emptyEditor(history: string[] = []): EditorState {
  return { text: "", cursor: 0, history, historyIndex: null, scratch: [] };
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
  | { type: "submitted"; text: string };

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

/** `i`, or the end of the grapheme it falls inside (an insert can merge with what follows). */
export function snap(text: string, i: number): number {
  const g = segmenter.segment(text).containing(i);
  return !g || g.index === i ? i : g.index + g.segment.length;
}

const splice = (s: EditorState, from: number, to: number, insert = ""): EditorState => {
  const text = s.text.slice(0, from) + insert + s.text.slice(to);
  return { ...s, text, cursor: snap(text, from + insert.length) };
};

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
  const index = s.historyIndex ?? s.history.length;
  if (index === 0) return s;
  // Keep what is showing, edits included, so walking back returns to it.
  const scratch = s.historyIndex === null ? [...s.history, s.text] : [...s.scratch];
  scratch[index] = s.text;
  return show({ ...s, scratch }, scratch[index - 1], index - 1);
}

function down(s: EditorState): EditorState {
  const end = lineEnd(s.text, s.cursor);
  if (end < s.text.length) {
    const col = graphemes(s.text.slice(lineStart(s.text, s.cursor), s.cursor)).length;
    return { ...s, cursor: atColumn(s.text, end + 1, lineEnd(s.text, end + 1), col) };
  }
  if (s.historyIndex === null || s.historyIndex === s.history.length) return s;
  const scratch = [...s.scratch];
  scratch[s.historyIndex] = s.text;
  return show({ ...s, scratch }, scratch[s.historyIndex + 1], s.historyIndex + 1);
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  if (action.type === "up") return up(state);
  if (action.type === "down") return down(state);

  // Edits while walking history change the shown entry; up/down keep them.
  const s = state;
  const { text, cursor } = s;
  switch (action.type) {
    case "insert":
      return splice(s, cursor, cursor, clean(action.text));
    case "set": {
      const set = clean(action.text);
      return { ...s, text: set, cursor: set.length };
    }
    case "newline":
      return splice(s, cursor, cursor, "\n");
    case "continueLine":
      return text[cursor - 1] === "\\" ? splice(s, cursor - 1, cursor, "\n") : splice(s, cursor, cursor, "\n");
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
      return { ...s, cursor: snap(text, wordLeft(text, cursor)) };
    case "wordRight":
      return { ...s, cursor: snap(text, wordRight(text, cursor)) };
    case "deleteWord":
      return splice(s, snap(text, wordLeft(text, cursor)), cursor);
    case "deleteToLineStart":
      return splice(s, lineStart(text, cursor), cursor);
    case "clear":
      return { ...s, text: "", cursor: 0 };
    case "submitted": {
      // Record what was sent, unless blank or a repeat of the last entry.
      // Text typed while it was being handled stays in the composer.
      const keep = action.text.trim() !== "" && s.history[s.history.length - 1] !== action.text;
      const history = keep ? [...s.history, action.text] : s.history;
      return text === action.text ? emptyEditor(history) : { ...s, history, historyIndex: null, scratch: [] };
    }
  }
}
