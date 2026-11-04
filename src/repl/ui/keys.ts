import type { Key } from "ink";
import type { EditorAction, EditorState } from "@/repl/ui/editor";

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
export function keyToAction(input: string, key: Partial<Key>, s: Pick<EditorState, "text" | "cursor">): KeyAction {
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
  // Esc and unbound Alt chords do nothing for now.
  if (key.escape || key.meta) return { type: "ignore" };
  return input ? { type: "insert", text: input } : { type: "ignore" };
}

const CONTROL = /([\x00-\x08\x0b\x0c\x0e-\x1f])/;

/**
 * Ink 8 passes typed text through as one chunk, splitting out only Ctrl+C,
 * Backspace and escape sequences, so keys typed faster than they're read
 * (SSH lag, tmux send-keys) arrive inside text. Other control bytes become
 * Ctrl+letter; Tab and LF stay as text, and bytes with no letter (NUL,
 * 0x1B–0x1F) are dropped. A single \r at the very end is Enter; any other \r
 * is unbracketed paste, kept as text for the editor to turn into newlines.
 */
export function chunkKeys(input: string): [string, Partial<Key>][] {
  const enter = input.endsWith("\r") && input.indexOf("\r") === input.length - 1;
  const keys: [string, Partial<Key>][] = [];
  for (const part of (enter ? input.slice(0, -1) : input).split(CONTROL)) {
    if (!CONTROL.test(part)) {
      if (part) keys.push([part, {}]);
      continue;
    }
    const code = part.charCodeAt(0);
    if (code >= 1 && code <= 26) keys.push([String.fromCharCode(code + 96), { ctrl: true }]);
  }
  if (enter) keys.push(["\r", { return: true }]);
  return keys;
}
