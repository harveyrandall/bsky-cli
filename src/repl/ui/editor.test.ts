import { describe, it, expect } from "vitest";
import { editorReducer as r, emptyEditor } from "./editor";

const at = (text: string, cursor = text.length) => ({ ...emptyEditor(), text, cursor });

describe("editorReducer", () => {
  it("inserts at the cursor and normalises CR and CRLF", () => {
    expect(r(at("ac", 1), { type: "insert", text: "b" })).toMatchObject({ text: "abc", cursor: 2 });
    expect(r(at(""), { type: "insert", text: "a\r\nb\rc" })).toMatchObject({ text: "a\nb\nc", cursor: 5 });
  });
  it("drops escape sequences and control bytes other than newline and tab", () => {
    expect(r(at(""), { type: "insert", text: "a\x1b[31mb\x1b[0m\x07c\td\x00" })).toMatchObject({ text: "abc\td", cursor: 5 });
  });
  it("moves and deletes by whole graphemes", () => {
    expect(r(at("a👍🏽"), { type: "backspace" })).toMatchObject({ text: "a", cursor: 1 });
    expect(r(at("👨‍👩‍👧b", 0), { type: "delete" })).toMatchObject({ text: "b", cursor: 0 });
    expect(r(at("a👍🏽"), { type: "left" }).cursor).toBe(1);
  });
  it("replaces a trailing backslash with a newline", () => {
    expect(r(at("a\\"), { type: "continueLine" })).toMatchObject({ text: "a\n", cursor: 2 });
  });
  it("jumps and deletes by words", () => {
    expect(r(at("one two  three"), { type: "wordLeft" }).cursor).toBe(9);
    expect(r(at("one two", 0), { type: "wordRight" }).cursor).toBe(3);
    expect(r(at("one two  "), { type: "deleteWord" })).toMatchObject({ text: "one ", cursor: 4 });
    expect(r(at("x\nabc def", 6), { type: "deleteToLineStart" })).toMatchObject({ text: "x\ndef", cursor: 2 });
  });
  it("works within the current line", () => {
    expect(r(at("ab\ncd", 4), { type: "lineStart" }).cursor).toBe(3);
    expect(r(at("ab\ncd", 0), { type: "lineEnd" }).cursor).toBe(2);
  });
  it("moves between lines, keeping the column", () => {
    expect(r(at("abc\nde", 6), { type: "up" }).cursor).toBe(2);
    expect(r(at("abc\nde", 3), { type: "down" }).cursor).toBe(6);
  });
  it("walks history from the first and last lines and restores the draft", () => {
    let s = { ...emptyEditor(["first", "second"]), text: "draft", cursor: 5 };
    s = r(s, { type: "up" }); expect(s.text).toBe("second");
    s = r(s, { type: "up" }); expect(s.text).toBe("first");
    s = r(s, { type: "up" }); expect(s.text).toBe("first");
    s = r(s, { type: "down" }); expect(s.text).toBe("second");
    s = r(s, { type: "down" }); expect(s).toMatchObject({ text: "draft", cursor: 5 });
  });
  it("submitted records history and clears", () => {
    expect(r(at("/help"), { type: "submitted" })).toMatchObject({ text: "", cursor: 0, history: ["/help"] });
  });
});
