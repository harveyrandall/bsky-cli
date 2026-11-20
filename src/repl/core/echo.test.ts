import { describe, it, expect } from "vitest";
import { echoLine } from "./echo";

describe("echoLine", () => {
  it.each([
    ["bsky ›", "/timeline -n 3"],
    ["thread ›", "first post"],
    ["thread (2) ›", "next"],
    ["thread A (A1) ›", "next"],
    ["reply→2 ›", "thanks"],
  ])("puts %s before the line", (prompt, input) => {
    expect(echoLine(prompt, input)).toBe(`${prompt} ${input}`);
  });
  it("indents the lines after the first to line up with the first, as the composer does", () => {
    expect(echoLine("thread (2) ›", "one\ntwo\nthree")).toBe(`thread (2) › one\n${" ".repeat(13)}two\n${" ".repeat(13)}three`);
    expect(echoLine("reply→2 ›", "a\nb")).toBe(`reply→2 › a\n${" ".repeat(10)}b`);
  });
  it.each(["", "   ", " \n "])("is the bare prompt for a blank line (%j)", (input) => {
    expect(echoLine("bsky ›", input)).toBe("bsky ›");
  });
  it.each([
    "/login me hunter2",
    "/login",
    "  /login me hunter2",
    '/login me "hunter 2',
    "/login me\nhunter2",
    "/LOGIN me hunter2",
  ])("leaves out what follows /login: %j", (input) => {
    expect(echoLine("bsky ›", input)).toBe("bsky › /login …");
  });
  it.each([
    "/run login me hunter2",
    "/run -p work login me hunter2",
    '/run login me "hunter 2',
    '/run "login" me hunter2',
  ])("leaves out what follows /run … login: %j", (input) => {
    expect(echoLine("bsky ›", input)).toBe("bsky › /run login …");
  });
  it.each(["/run timeline", "/running login me", "/loginx", "login me hunter2", "\\/login me hunter2"])(
    "shows anything else as typed: %j",
    (input) => {
      expect(echoLine("bsky ›", input)).toBe(`bsky › ${input}`);
    },
  );
});
