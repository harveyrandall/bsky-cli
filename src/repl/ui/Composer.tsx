import { useReducer, useRef } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import { completeCommand } from "@/repl/core/commands";
import type { DispatchResult } from "@/repl/core/dispatch";
import { segmentAt, type Markers } from "@/repl/core/markers";
import { editorReducer, emptyEditor, type EditorAction } from "@/repl/ui/editor";
import { keyToAction } from "@/repl/ui/keys";
import { Ring } from "@/repl/ui/Ring";

const PROMPT = "bsky › ";
const INDENT = " ".repeat(PROMPT.length);
const segmenter = new Intl.Segmenter();

export interface ComposerProps {
  markers: Markers;
  onSubmit(text: string): Promise<DispatchResult>;
  onHint(text: string): void;
  onExit(): void;
}

export function Composer({ markers, onSubmit, onHint, onExit }: ComposerProps) {
  // Editor state lives in a ref so keys that arrive in one stdin chunk (fast
  // typing, slow SSH) each see the text the previous key left behind.
  const editor = useRef(emptyEditor());
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const apply = (action: EditorAction) => {
    editor.current = editorReducer(editor.current, action);
    rerender();
  };

  useInput(async (input, key) => {
    const action = keyToAction(input, key, editor.current);
    const { text, cursor } = editor.current;
    switch (action.type) {
      case "ignore":
        return;
      case "submit":
        if (text.trim() !== "" && (await onSubmit(text)) === "done") apply({ type: "submitted" });
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
  });
  usePaste((text) => apply({ type: "insert", text }));

  const { text, cursor } = editor.current;
  let start = 0;
  return (
    <Box flexDirection="column">
      {text.split("\n").map((line, i) => {
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
      <Ring segment={segmentAt(text, cursor, markers)} />
    </Box>
  );
}
