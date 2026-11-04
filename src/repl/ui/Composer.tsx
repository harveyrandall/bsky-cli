import { useEffect, useReducer, useRef } from "react";
import { Box, Text, useInput, usePaste, useWindowSize, type Key } from "ink";
import { completeCommand } from "@/repl/core/commands";
import { segmentAt, type Markers } from "@/repl/core/markers";
import type { EscapeResult, Repl, SubmitOutcome } from "@/repl/core/repl";
import { editorReducer, emptyEditor, type EditorAction, type EditorState } from "@/repl/ui/editor";
import { chunkKeys, keyToAction } from "@/repl/ui/keys";
import { Ring } from "@/repl/ui/Ring";

const STILL_WORKING = "Still working — wait for it to finish.";

const segmenter = new Intl.Segmenter();
const cells = (text: string) => [...segmenter.segment(text)].length;

// East Asian wide characters, emoji and flags take two terminal cells.
const WIDE =
  /\p{Extended_Pictographic}|\p{Regional_Indicator}|[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;

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
function layoutRows(text: string, width: number, prompt: string, indent: string): Row[] {
  const rows: Row[] = [];
  let offset = 0;
  text.split("\n").forEach((line, i) => {
    let prefix = i === 0 ? prompt : indent;
    let start = 0;
    let used = 0;
    for (const { index, segment } of segmenter.segment(line)) {
      const cellWidth = WIDE.test(segment) ? 2 : 1;
      if (used + cellWidth > width) {
        rows.push({ prefix, start: offset + start, end: offset + index });
        [prefix, start, used] = [indent, index, 0];
      }
      used += cellWidth;
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

export interface ComposerProps {
  markers: Markers;
  prompt: string;
  limit: number;
  /** A post waiting out its undo window: shown dimmed and read-only; Enter sends it now. */
  pending?: string;
  /** False while an overlay has the keyboard. */
  active?: boolean;
  /** Staged files, shown above the draft. */
  chips?: string;
  /** Text coming back (a rejected post, a paste that wasn't a drop): added whenever `id` changes. */
  restore?: { id: number; text: string };
  /** The draft, whenever it changes. */
  onEditor(state: EditorState): void;
  onSubmit(text: string): Promise<SubmitOutcome>;
  onEscape(text: string): EscapeResult;
  onInterrupt(text: string): ReturnType<Repl["interrupt"]>;
  onEof(text: string): void;
  onSendNow(): void;
  /** Ctrl+G: the text back from $EDITOR. */
  onEdit(text: string): Promise<string>;
  /** A paste into an empty composer: true if it's been dealt with. */
  onPaste(text: string): boolean;
  onHint(text: string): void;
  onError(message: string): void;
}

export function Composer(props: ComposerProps) {
  const { markers, prompt, limit, pending, active = true, restore, chips } = props;
  const { rows: windowRows, columns } = useWindowSize();
  // Editor state lives in a ref so keys that arrive in one stdin chunk (fast
  // typing, slow SSH) each see the text the previous key left behind.
  const editor = useRef(emptyEditor());
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const apply = (action: EditorAction) => {
    editor.current = editorReducer(editor.current, action);
    props.onEditor(editor.current);
    rerender();
  };

  useEffect(() => {
    if (restore) apply({ type: "insert", text: restore.text });
  }, [restore?.id]);

  // The REPL never exits on an error: report it and keep the draft.
  const report = (err: unknown) => props.onError(err instanceof Error ? err.message || err.name : String(err));

  const outcome = (text: string, out: SubmitOutcome | EscapeResult | ReturnType<Repl["interrupt"]>) => {
    if (out === "done") apply({ type: "submitted", text });
    else if (out === "clear") apply({ type: "clear" });
    else if (out === "hint") props.onHint("Ctrl+D to exit");
    else if (typeof out === "object") {
      if (out.restore !== text) apply({ type: "submitted", text });
      apply({ type: "set", text: out.restore });
    }
  };

  const submitting = useRef(false);
  const submit = async (text: string) => {
    if (text.trim() === "") {
      if (chips) props.onHint("Type some text to go with it: posts need text");
      return;
    }
    if (submitting.current) {
      props.onHint(STILL_WORKING);
      return;
    }
    submitting.current = true;
    try {
      outcome(text, await props.onSubmit(text));
    } catch (err) {
      report(err);
    } finally {
      submitting.current = false;
    }
  };

  const handle = (input: string, key: Partial<Key>) => {
    const action = keyToAction(input, key, editor.current);
    const { text, cursor } = editor.current;
    switch (action.type) {
      case "escape":
        return outcome(text, props.onEscape(text));
      case "interrupt":
        return outcome(text, props.onInterrupt(text));
      case "eof":
        return submitting.current ? props.onHint(STILL_WORKING) : props.onEof(text);
    }
    // While a post waits out its undo window the composer only sends it now.
    if (pending !== undefined) {
      if (action.type === "submit") props.onSendNow();
      return;
    }
    switch (action.type) {
      case "ignore":
        return;
      case "submit":
        void submit(text);
        return;
      case "edit":
        props.onEdit(text).then((edited) => apply({ type: "set", text: edited }), report);
        return;
      case "complete": {
        const completed = completeCommand(text, cursor);
        if (completed.text !== text) apply({ type: "set", text: completed.text });
        else if (completed.candidates.length > 1) props.onHint(completed.candidates.map((c) => `/${c}`).join("  "));
        return;
      }
      default:
        apply(action);
    }
  };

  useInput(
    (input, key) => {
      try {
        if (input.length > 1 && /[\x00-\x1f]/.test(input)) {
          for (const [part, partKey] of chunkKeys(input)) handle(part, partKey);
        } else {
          handle(input, key);
        }
      } catch (err) {
        report(err);
      }
    },
    { isActive: active },
  );
  usePaste(
    (text) => {
      try {
        if (pending !== undefined) return;
        if (editor.current.text === "" && props.onPaste(text)) return;
        apply({ type: "insert", text });
      } catch (err) {
        report(err);
      }
    },
    { isActive: active },
  );

  const promptText = `${prompt} `;
  const indent = " ".repeat(cells(promptText));
  if (pending !== undefined) {
    return (
      <Text dimColor wrap="truncate">
        {promptText + pending.split("\n")[0]}
      </Text>
    );
  }

  const { text, cursor } = editor.current;
  // One cell stays free at the end of each row for the cursor.
  const rows = layoutRows(text, Math.max(1, columns - cells(promptText) - 1), promptText, indent);
  // At a wrap point the cursor belongs to the row that starts there.
  let cursorRow = 0;
  rows.forEach((row, i) => {
    if (row.start <= cursor) cursorRow = i;
  });
  const [first, last] = visibleRows(rows.length, cursorRow, chips ? windowRows - 1 : windowRows);
  const hidden = (n: number, arrow: string) =>
    n > 0 && <Text dimColor>{`${indent}${arrow} ${n} more line${n === 1 ? "" : "s"}`}</Text>;
  return (
    <Box flexDirection="column">
      {chips && (
        <Text dimColor wrap="truncate">
          {chips}
        </Text>
      )}
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
      <Ring segment={segmentAt(text, cursor, markers)} limit={limit} />
    </Box>
  );
}
