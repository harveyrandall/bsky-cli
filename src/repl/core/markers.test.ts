import { describe, it, expect } from "vitest";
import { graphemeLength } from "@/lib/split-thread";
import { DEFAULT_MARKERS, DEFAULT_MARKERS as m, parseSubmit, resolveMarkers, scanMarkers, segmentAt } from "./markers";

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
  it("ignores a cut marker after the send marker", () => {
    expect(segmentAt("a //> b <// c", 0, m)).toEqual({ index: 1, total: 1, text: "a", region: "send" });
    expect(segmentAt("a //> b <// c", 12, m)).toMatchObject({ region: "kept", text: "b <// c" });
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
    [{ splitMarker: "" }, 'Invalid [repl] split-marker = "": markers can\'t be empty'],
    [{ sendMarker: "a b" }, 'Invalid [repl] send-marker = "a b": markers can\'t contain spaces'],
    [{ cutMarker: 5 }, "Invalid [repl] cut-marker = 5: markers must be text"],
    [{ cutMarker: "///" }, 'Invalid [repl] cut-marker = "///": markers must differ from each other'],
    [{ sendMarker: "/send" }, 'Invalid [repl] send-marker = "/send": markers can\'t start with / and a letter, which begins a command'],
  ])("rejects %o", (opts, message) => {
    expect(() => resolveMarkers(opts)).toThrow(message);
  });
  it("can't be changed after the fact", () => {
    expect(Object.isFrozen(DEFAULT_MARKERS)).toBe(true);
  });
});

describe("an empty marker", () => {
  it("is never matched, so scanning can't stall", () => {
    expect(segmentAt("hi", 2, { ...m, split: "" })).toEqual({ index: 1, total: 1, text: "hi", region: "send" });
  });
});

describe("parseSubmit", () => {
  const p = (text: string, limit = 300) => parseSubmit(text, m, limit);
  it("sends up to //> and keeps the rest as typed", () => {
    expect(p("a //> b <// c")).toEqual({ posts: ["a"], keep: "b <// c", autoSplit: false, markersUsed: true, overLimit: [] });
  });
  it("discards what follows <// in the send part", () => {
    expect(p("a <// b //> c")).toMatchObject({ posts: ["a"], discard: "b", keep: "c" });
  });
  it("splits at /// and drops empty pieces", () => {
    expect(p("one /// two ///")).toMatchObject({ posts: ["one", "two"], markersUsed: true });
  });
  it("removes escapes and doesn't count escaped markers", () => {
    expect(p("file:\\///tmp")).toMatchObject({ posts: ["file:///tmp"], markersUsed: false });
  });
  it("auto-splits long text without markers", () => {
    const plan = p("word ".repeat(70).trim());
    expect(plan).toMatchObject({ autoSplit: true, markersUsed: false, overLimit: [] });
    expect(plan.posts.length).toBeGreaterThan(1);
    for (const post of plan.posts) expect(graphemeLength(post)).toBeLessThanOrEqual(300);
  });
  it("honours a smaller limit", () => {
    const text = "x ".repeat(149) + "x";
    expect(p(text).autoSplit).toBe(false);
    expect(p(text, 298).autoSplit).toBe(true);
  });
  it("flags a marker-made post over the limit instead of splitting it", () => {
    const plan = p(`short /// ${"y".repeat(320)}`);
    expect(plan).toMatchObject({ autoSplit: false, overLimit: [1] });
    expect(plan.posts[1]).toHaveLength(320);
  });
  it("uses custom markers", () => {
    expect(parseSubmit("a ~~ b", { ...m, split: "~~" }, 300).posts).toEqual(["a", "b"]);
  });
  it("has no posts for blank text", () => {
    expect(p("   ").posts).toEqual([]);
  });
});
