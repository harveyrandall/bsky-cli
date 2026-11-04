import { useReducer, useRef } from "react";
import { Box, Text, useInput, usePaste, useWindowSize, type Key } from "ink";
import { completeCommand } from "@/repl/core/commands";
import type { DispatchResult } from "@/repl/core/dispatch";
import { segmentAt, type Markers } from "@/repl/core/markers";
import { editorReducer, emptyEditor, type EditorAction } from "@/repl/ui/editor";
import { chunkKeys, keyToAction } from "@/repl/ui/keys";
import { Ring } from "@/repl/ui/Ring";

const PROMPT = "bsky › ";
const INDENT = " ".repeat(PROMPT.length);
const segmenter = new Intl.Segmenter();

// East Asian wide characters, emoji and flags take two terminal cells.
const WIDE =
  /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;

/** One terminal row of the draft: text[start, end) after `prefix`. */
interface Row {
  prefix: string;
  start: number;
  end: number;
}

/**
 * Break the draft into terminal rows the way a terminal wraps, by cell width
 * and mid-word, so the composer knows its height exactly. Each row is drawn
 * truncated to one line, so a misjudged width can cut a row short but never
 * make the frame taller.
 */
function layoutRows(text: string, width: number): Row[] {
  const rows: Row[] = [];
  let offset = 0;
  text.split("\n").forEach((line, i) => {
    let prefix = i === 0 ? PROMPT : INDENT;
    let start = 0;
    let cells = 0;
    for (const { index, segment } of segmenter.segment(line)) {
      const cellWidth = WIDE.test(segment) ? 2 : 1;
      if (cells + cellWidth > width) {
        rows.push({ prefix, start: offset + start, end: offset + index });
        [prefix, start, cells] = [INDENT, index, 0];
      }
      cells += cellWidth;
    }
    rows.push({ prefix, start: offset + start, end: offset + line.length });
    offset += line.length + 1;
  });
  return rows;
}

/**
 * Rows [first, last) to draw. Once a frame is taller than the window (as tall,
 * on Windows), Ink erases the screen and rewrites the whole frame on every
 * update, pushing a copy into scrollback each time. So a taller draft shows
 * only the rows around the cursor, with markers for how many are hidden.
 */
function visibleRows(total: number, cursorRow: number, windowRows: number): [number, number] {
  const room = windowRows - 2; // the ring, plus one row to stay shorter than the window
  if (total <= room) return [0, total];
  const budget = Math.max(1, room - 2); // the ↑ and ↓ markers
  const first = Math.max(0, Math.min(cursorRow - Math.floor((budget - 1) / 2), total - budget));
  return [first, first + budget];
}

const hidden = (n: number, arrow: string) =>
  n > 0 && <Text dimColor>{`${INDENT}${arrow} ${n} more line${n === 1 ? "" : "s"}`}</Text>;

export interface ComposerProps {
  markers: Markers;
  onSubmit(text: string): Promise<DispatchResult>;
  onHint(text: string): void;
  onExit(): void;
}

export function Composer({ markers, onSubmit, onHint, onExit }: ComposerProps) {
  const { rows: windowRows, columns } = useWindowSize();
  // Editor state lives in a ref so keys that arrive in one stdin chunk (fast
  // typing, slow SSH) each see the text the previous key left behind.
  const editor = useRef(emptyEditor());
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const apply = (action: EditorAction) => {
    editor.current = editorReducer(editor.current, action);
    rerender();
  };

  const submitting = useRef(false);
  const submit = async (text: string) => {
    if (text.trim() === "" || submitting.current) return;
    submitting.current = true;
    try {
      if ((await onSubmit(text)) === "done") apply({ type: "submitted", text });
    } catch (err) {
      onHint(err instanceof Error ? err.message : String(err));
    } finally {
      submitting.current = false;
    }
  };

  const handle = (input: string, key: Partial<Key>) => {
    const action = keyToAction(input, key, editor.current);
    const { text, cursor } = editor.current;
    switch (action.type) {
      case "ignore":
        return;
      case "submit":
        void submit(text);
        return;
      case "complete": {
        const completed = completeCommand(text, cursor);
        if (completed.text !== text) apply({ type: "set", text: completed.text });
        else if (completed.candidates.length > 1) onHint(completed.candidates.map((c) => `/${c}`).join("  "));
        return;
      }
      case "interrupt":
        if (text) apply({ type: "clear" });
        else onHint("Ctrl+D to exit");
        return;
      case "eof":
        onExit();
        return;
      default:
        apply(action);
    }
  };

  useInput((input, key) => {
    if (input.length > 1 && /[\x00-\x1f]/.test(input)) {
      for (const [part, partKey] of chunkKeys(input)) handle(part, partKey);
    } else {
      handle(input, key);
    }
  });
  usePaste((text) => apply({ type: "insert", text }));

  const { text, cursor } = editor.current;
  // One cell stays free at the end of each row for the cursor.
  const rows = layoutRows(text, Math.max(1, columns - PROMPT.length - 1));
  // At a wrap point the cursor belongs to the row that starts there.
  let cursorRow = 0;
  rows.forEach((row, i) => {
    if (row.start <= cursor) cursorRow = i;
  });
  const [first, last] = visibleRows(rows.length, cursorRow, windowRows);
  return (
    <Box flexDirection="column">
      {hidden(first, "↑")}
      {rows.slice(first, last).map((row, j) => {
        const shown = text.slice(row.start, row.end);
        if (first + j !== cursorRow) {
          return (
            <Text key={row.start} wrap="truncate">
              {row.prefix + shown}
            </Text>
          );
        }
        const at = cursor - row.start;
        const under = segmenter.segment(shown).containing(at)?.segment ?? "";
        return (
          <Text key={row.start} wrap="truncate">
            {row.prefix + shown.slice(0, at)}
            <Text inverse>{under || " "}</Text>
            {shown.slice(at + under.length)}
          </Text>
        );
      })}
      {hidden(rows.length - last, "↓")}
      <Ring segment={segmentAt(text, cursor, markers)} />
    </Box>
  );
}
