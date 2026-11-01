import { describe, it, expect } from "vitest";
import { DEFAULT_MARKERS as m, resolveMarkers, scanMarkers, segmentAt } from "./markers";

describe("scanMarkers", () => {
  it("finds each marker kind with offsets", () => {
    expect(scanMarkers("a /// b //> c <// d", m)).toEqual([
      { kind: "split", start: 2, end: 5 },
      { kind: "send", start: 8, end: 11 },
      { kind: "cut", start: 14, end: 17 },
    ]);
  });
  it("ignores escaped markers", () => {
    expect(scanMarkers("file:\\///tmp", m)).toEqual([]);
  });
  it("prefers the longest marker at a position", () => {
    expect(scanMarkers("a ///b", { split: "//", send: "///", cut: "<<" })).toEqual([
      { kind: "send", start: 2, end: 5 },
    ]);
  });
});

describe("segmentAt", () => {
  it("treats unmarked text as one segment", () => {
    expect(segmentAt("hello", 5, m)).toEqual({ index: 1, total: 1, text: "hello", region: "send" });
  });
  it("returns the trimmed segment under the cursor", () => {
    expect(segmentAt("one /// two /// three", 9, m)).toEqual({ index: 2, total: 3, text: "two", region: "send" });
  });
  it("puts a cursor right after a marker in the next segment", () => {
    expect(segmentAt("one ///", 7, m)).toEqual({ index: 2, total: 2, text: "", region: "send" });
  });
  it("removes escapes before counting", () => {
    expect(segmentAt("file:\\///tmp", 0, m).text).toBe("file:///tmp");
  });
  it("marks text after //> as kept", () => {
    expect(segmentAt("now //> later", 12, m)).toMatchObject({ region: "kept", text: "later" });
  });
  it("marks text after <// in the send part as cut", () => {
    expect(segmentAt("post <// scrap //> later", 11, m)).toMatchObject({ region: "cut", text: "scrap" });
  });
  it("counts only send pieces", () => {
    expect(segmentAt("a /// b <// c", 0, m)).toEqual({ index: 1, total: 2, text: "a", region: "send" });
  });
});

describe("resolveMarkers", () => {
  it("defaults and overrides", () => {
    expect(resolveMarkers({})).toEqual(m);
    expect(resolveMarkers({ splitMarker: "~~" })).toEqual({ ...m, split: "~~" });
  });
  it.each([
    [{ splitMarker: "" }, 'Invalid [repl] split-marker = ""'],
    [{ sendMarker: "a b" }, 'Invalid [repl] send-marker = "a b"'],
    [{ cutMarker: 5 }, "Invalid [repl] cut-marker = 5"],
    [{ cutMarker: "///" }, 'Invalid [repl] cut-marker = "///"'],
  ])("rejects %o", (opts, message) => {
    expect(() => resolveMarkers(opts)).toThrow(message);
  });
});
