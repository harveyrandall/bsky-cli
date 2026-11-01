import type { Key } from "ink";
import type { EditorAction } from "@/repl/ui/editor";

export type KeyAction =
  | EditorAction
  | { type: "submit" }
  | { type: "complete" }
  | { type: "interrupt" }
  | { type: "eof" }
  | { type: "ignore" };

const CTRL = new Map<string, KeyAction>([
  ["c", { type: "interrupt" }],
  ["d", { type: "eof" }],
  ["a", { type: "lineStart" }],
  ["e", { type: "lineEnd" }],
  ["w", { type: "deleteWord" }],
  ["u", { type: "deleteToLineStart" }],
]);

/**
 * Map one Ink keypress to an action; first match wins. Shift+Enter only
 * arrives under the kitty protocol, so Alt+Enter and Ctrl+J also add a newline.
 */
export function keyToAction(input: string, key: Key, s: { text: string; cursor: number }): KeyAction {
  if (key.return && (key.shift || key.meta)) return { type: "newline" };
  if (input === "\n" || (key.ctrl && input === "j")) return { type: "newline" };
  if (key.return) {
    const atLineEnd = s.cursor === s.text.length || s.text[s.cursor] === "\n";
    return { type: atLineEnd && s.text[s.cursor - 1] === "\\" ? "continueLine" : "submit" };
  }
  if (key.tab) return { type: "complete" };
  if (key.ctrl) return CTRL.get(input) ?? { type: "ignore" };
  if (key.meta && (key.leftArrow || input === "b")) return { type: "wordLeft" };
  if (key.meta && (key.rightArrow || input === "f")) return { type: "wordRight" };
  if (key.leftArrow) return { type: "left" };
  if (key.rightArrow) return { type: "right" };
  if (key.upArrow) return { type: "up" };
  if (key.downArrow) return { type: "down" };
  if (key.home) return { type: "lineStart" };
  if (key.end) return { type: "lineEnd" };
  if (key.backspace) return { type: "backspace" };
  if (key.delete) return { type: "delete" };
  // Esc routing arrives in PR 2.
  if (key.escape || key.meta) return { type: "ignore" };
  return input ? { type: "insert", text: input } : { type: "ignore" };
}
