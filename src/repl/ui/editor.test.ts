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
  it("continues a line with a plain newline when no backslash precedes the cursor", () => {
    expect(r(at("abc", 0), { type: "continueLine" })).toMatchObject({ text: "\nabc", cursor: 1 });
  });
  it("cleans text it is given to set", () => {
    expect(r(at(""), { type: "set", text: "a\x1b[31mb\r\n" })).toMatchObject({ text: "ab\n", cursor: 3 });
  });
  it("keeps the cursor on a grapheme boundary when an insert or word jump lands inside one", () => {
    expect(r(at("\u0301x", 0), { type: "insert", text: "e" })).toMatchObject({ text: "e\u0301x", cursor: 2 });
    expect(r(at("a \u0301b"), { type: "wordLeft" }).cursor).toBe(3);
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
  it("keeps the draft and each edited entry while walking history", () => {
    let s = { ...emptyEditor(["first", "second"]), text: "draft", cursor: 5 };
    s = r(s, { type: "up" });
    s = r(s, { type: "insert", text: "!" }); expect(s.text).toBe("second!");
    s = r(s, { type: "up" }); expect(s.text).toBe("first");
    s = r(s, { type: "down" }); expect(s.text).toBe("second!");
    s = r(s, { type: "down" }); expect(s).toMatchObject({ text: "draft", cursor: 5 });
  });
  it("submitted records history and clears", () => {
    expect(r(at("/help"), { type: "submitted", text: "/help" })).toMatchObject({ text: "", cursor: 0, history: ["/help"] });
  });
  it("submitted records what was sent and keeps text typed since", () => {
    expect(r(at("/helxp", 5), { type: "submitted", text: "/help" })).toMatchObject({
      text: "/helxp",
      cursor: 5,
      history: ["/help"],
    });
  });
  it("submitted leaves only what was typed after it, not stuck to the command", () => {
    expect(r(at("/timeline -n 5great", 19), { type: "submitted", text: "/timeline -n 5" })).toMatchObject({
      text: "great",
      cursor: 5,
      history: ["/timeline -n 5"],
    });
  });
  it("drops a lone control byte that isn't part of an escape sequence", () => {
    expect(r(at(""), { type: "insert", text: "a\x07b" })).toMatchObject({ text: "ab" });
  });
  it("records a repeated submit once", () => {
    let s = r(at("/help"), { type: "submitted", text: "/help" });
    s = r({ ...s, text: "/help", cursor: 5 }, { type: "submitted", text: "/help" });
    expect(s.history).toEqual(["/help"]);
  });
  it("does nothing on ↑ with no history", () => {
    expect(r(at("draft"), { type: "up" })).toMatchObject({ text: "draft", cursor: 5, historyIndex: null });
  });
  it("jumps words across newlines", () => {
    expect(r(at("one\ntwo", 4), { type: "wordLeft" }).cursor).toBe(0);
    expect(r(at("one\ntwo", 3), { type: "wordRight" }).cursor).toBe(7);
  });
});
