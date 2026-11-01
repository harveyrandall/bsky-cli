import { describe, it, expect } from "vitest";
import type { Key } from "ink";
import { chunkKeys, keyToAction } from "./keys";

const key = (k: Partial<Key> = {}): Key => ({
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
  home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false,
  backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false,
  ...k,
});
const s = (text: string, cursor = text.length) => ({ text, cursor });

describe("keyToAction", () => {
  it.each([
    ["Enter", "\r", key({ return: true }), s("hi"), { type: "submit" }],
    ["Shift+Enter (kitty)", "\r", key({ return: true, shift: true }), s("hi"), { type: "newline" }],
    ["Alt+Enter", "", key({ return: true, meta: true }), s("hi"), { type: "newline" }],
    ["Ctrl+J", "\n", key(), s("hi"), { type: "newline" }],
    ["Ctrl+J (kitty)", "j", key({ ctrl: true }), s("hi"), { type: "newline" }],
    ["trailing \\ + Enter", "\r", key({ return: true }), s("hi\\"), { type: "continueLine" }],
    ["\\ mid-line + Enter", "\r", key({ return: true }), s("a\\b", 2), { type: "submit" }],
    ["Tab", "", key({ tab: true }), s("/he"), { type: "complete" }],
    ["Ctrl+C", "c", key({ ctrl: true }), s(""), { type: "interrupt" }],
    ["Ctrl+D", "d", key({ ctrl: true }), s(""), { type: "eof" }],
    ["Ctrl+A", "a", key({ ctrl: true }), s("x"), { type: "lineStart" }],
    ["Ctrl+E", "e", key({ ctrl: true }), s("x"), { type: "lineEnd" }],
    ["Ctrl+W", "w", key({ ctrl: true }), s("x"), { type: "deleteWord" }],
    ["Ctrl+U", "u", key({ ctrl: true }), s("x"), { type: "deleteToLineStart" }],
    ["Alt+B", "b", key({ meta: true }), s("x"), { type: "wordLeft" }],
    ["Alt+←", "", key({ meta: true, leftArrow: true }), s("x"), { type: "wordLeft" }],
    ["Alt+F", "f", key({ meta: true }), s("x"), { type: "wordRight" }],
    ["Backspace", "", key({ backspace: true }), s("x"), { type: "backspace" }],
    ["Delete", "", key({ delete: true }), s("x"), { type: "delete" }],
    ["Esc", "", key({ escape: true }), s("x"), { type: "ignore" }],
    ["unbound Ctrl", "x", key({ ctrl: true }), s("x"), { type: "ignore" }],
    ["text", "hé", key(), s(""), { type: "insert", text: "hé" }],
  ])("%s", (_name, input, k, state, action) => {
    expect(keyToAction(input, k, state)).toEqual(action);
  });
});

describe("chunkKeys", () => {
  it("turns control bytes inside typed text into their keys", () => {
    expect(chunkKeys("abc\x04")).toEqual([["abc", {}], ["d", { ctrl: true }]]);
    expect(chunkKeys("ab\x15cd")).toEqual([["ab", {}], ["u", { ctrl: true }], ["cd", {}]]);
  });
  it("treats one \\r at the end as Enter and any other \\r as pasted text", () => {
    expect(chunkKeys("/help\r")).toEqual([["/help", {}], ["\r", { return: true }]]);
    expect(chunkKeys("a\rb\r")).toEqual([["a\rb\r", {}]]);
  });
});
