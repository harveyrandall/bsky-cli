import { useReducer, useRef } from "react";
import { Box, Text, useInput, usePaste, useWindowSize, type Key } from "ink";
import { graphemeLength } from "@/lib/split-thread";
import { completeCommand } from "@/repl/core/commands";
import type { DispatchResult } from "@/repl/core/dispatch";
import { segmentAt, type Markers } from "@/repl/core/markers";
import { editorReducer, emptyEditor, type EditorAction } from "@/repl/ui/editor";
import { chunkKeys, keyToAction } from "@/repl/ui/keys";
import { Ring } from "@/repl/ui/Ring";

const PROMPT = "bsky › ";
const INDENT = " ".repeat(PROMPT.length);
const segmenter = new Intl.Segmenter();

/**
 * Lines [first, last) to draw. Ink clears and redraws the whole screen once a
 * frame is as tall as the window, so a taller draft shows only the lines
 * around the cursor, with a marker for how many are hidden above and below.
 */
function visibleLines(lines: string[], cursorLine: number, rows: number, columns: number): [number, number] {
  // ponytail: width is counted in graphemes, so wide characters (CJK, emoji)
  // undercount and such drafts can still overflow; measure with string-width if that bites.
  const heights = lines.map((l) => Math.max(1, Math.ceil((PROMPT.length + graphemeLength(l) + 1) / columns)));
  const room = rows - 2; // the ring, and one spare row
  if (heights.reduce((a, b) => a + b, 0) <= room) return [0, lines.length];
  const budget = room - 2; // the ↑ and ↓ markers
  let first = cursorLine;
  let last = cursorLine + 1;
  let used = heights[cursorLine];
  for (let grew = true; grew; ) {
    grew = false;
    if (last < lines.length && used + heights[last] <= budget) {
      used += heights[last++];
      grew = true;
    }
    if (first > 0 && used + heights[first - 1] <= budget) {
      used += heights[--first];
      grew = true;
    }
  }
  return [first, last];
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
  const { rows, columns } = useWindowSize();
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
  const lines = text.split("\n");
  const [first, last] = visibleLines(lines, text.slice(0, cursor).split("\n").length - 1, rows, columns);
  let start = lines.slice(0, first).reduce((n, l) => n + l.length + 1, 0);
  return (
    <Box flexDirection="column">
      {hidden(first, "↑")}
      {lines.slice(first, last).map((line, j) => {
        const i = first + j;
        const lineStart = start;
        start += line.length + 1;
        const prefix = i === 0 ? PROMPT : INDENT;
        if (cursor < lineStart || cursor > lineStart + line.length) {
          return <Text key={i}>{prefix + line}</Text>;
        }
        const at = cursor - lineStart;
        const under = segmenter.segment(line).containing(at)?.segment ?? "";
        return (
          <Text key={i}>
            {prefix + line.slice(0, at)}
            <Text inverse>{under || " "}</Text>
            {line.slice(at + under.length)}
          </Text>
        );
      })}
      {hidden(lines.length - last, "↓")}
      <Ring segment={segmentAt(text, cursor, markers)} />
    </Box>
  );
}
