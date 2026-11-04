import { describe, it, expect, vi } from "vitest";
import { dispatch, parseInput } from "./dispatch";
import type { Repl } from "./repl";

function fakeRepl() {
  return {
    submitText: vi.fn(async () => "keep" as const),
    startThread: vi.fn(async () => "done" as const),
    reply: vi.fn(async () => "done" as const),
    replyFrom: vi.fn(async (): Promise<"done" | "keep"> => "done"),
    post: vi.fn(async () => "done" as const),
    setAutoThread: vi.fn(),
    setCooldown: vi.fn(),
    askSettings: vi.fn(async () => {}),
    settingsLine: vi.fn(() => "undo 5s · pace off · auto-thread off"),
    retry: vi.fn(async () => {}),
    settings: () => ({ verbose: false }),
    registry: { entries: () => [{ excerpt: "hello" }], format: () => "(1) 3lbx7kt5def2a" },
  };
}
const ctx = () => {
  const repl = fakeRepl();
  return { print: vi.fn(), exit: vi.fn(), repl: repl as unknown as Repl, fake: repl };
};
const printed = (c: ReturnType<typeof ctx>) => c.print.mock.calls.map((call) => call[0]).join("\n");

describe("parseInput", () => {
  it("classifies input", () => {
    expect(parseInput("   ")).toEqual({ kind: "empty" });
    expect(parseInput("/help exit")).toEqual({ kind: "command", name: "help", rest: "exit" });
    expect(parseInput("/Help")).toEqual({ kind: "text", text: "/Help" });
    expect(parseInput("\\/tmp is a path")).toEqual({ kind: "text", text: "/tmp is a path" });
    expect(parseInput("  \\/tmp")).toEqual({ kind: "text", text: "  /tmp" });
    expect(parseInput("//> keep")).toEqual({ kind: "text", text: "//> keep" });
  });
});

describe("dispatch", () => {
  it("/thread takes quotes off a ref-shaped argument and leaves other quotes in the post", async () => {
    const c = ctx();
    await dispatch('/thread "42"', c);
    expect(c.fake.startThread).toHaveBeenLastCalledWith("42", { asText: true });
    await dispatch('/thread "Hello," she said, "hi"', c);
    expect(c.fake.startThread).toHaveBeenLastCalledWith('"Hello," she said, "hi"', {});
  });
  it("/reply-from keeps the text when it can't go ahead", async () => {
    const c = ctx();
    c.fake.replyFrom.mockResolvedValueOnce("keep");
    expect(await dispatch("/reply-from 9", c)).toBe("keep");
  });
  it("/exit and /quit exit", async () => {
    for (const input of ["/exit", "/quit"]) {
      const c = ctx();
      expect(await dispatch(input, c)).toBe("done");
      expect(c.exit).toHaveBeenCalledOnce();
    }
  });
  it("/help lists every command", async () => {
    const c = ctx();
    expect(await dispatch("/help", c)).toBe("done");
    expect(printed(c)).toContain("/help [command]");
    expect(printed(c)).toContain("/exit");
  });
  it("/help <cmd> shows usage and aliases", async () => {
    const c = ctx();
    await dispatch("/help exit", c);
    expect(printed(c)).toContain("Aliases: /quit");
  });
  it("suggests a close command and keeps the text", async () => {
    const c = ctx();
    expect(await dispatch("/hlp", c)).toBe("keep");
    expect(c.print).toHaveBeenCalledWith("Unknown /hlp. Did you mean /help?", "error");
  });
  it("points at /help when nothing is close", async () => {
    const c = ctx();
    expect(await dispatch("/zzzz", c)).toBe("keep");
    expect(c.print).toHaveBeenCalledWith("Unknown /zzzz. /help lists commands.", "error");
  });
  it.each([
    ['/help "exit', '/help: Unclosed " quote'],
    ["/help 'exit", "/help: Unclosed ' quote"],
  ])("reports %s as one error line naming the command, and keeps the text", async (input, message) => {
    const c = ctx();
    expect(await dispatch(input, c)).toBe("keep");
    expect(c.print.mock.calls).toEqual([[message, "error"]]);
  });
  it("hands plain text to the session and returns what it says", async () => {
    const c = ctx();
    expect(await dispatch("hello\nworld", c)).toBe("keep");
    expect(c.fake.submitText).toHaveBeenCalledWith("hello\nworld");
  });
});

describe("writing commands", () => {
  it.each([
    ["/thread", [undefined, {}]],
    ["/thread hello there", ["hello there", {}]],
    ["/thread 42", ["42", {}]],
    ['/thread "42"', ["42", { asText: true }]],
    ["/thread --undo 5 --pace 10 don't stop", ["don't stop", { undo: 5, pace: 10 }]],
  ])("%s", async (input, args) => {
    const c = ctx();
    await dispatch(input, c);
    expect(c.fake.startThread).toHaveBeenCalledWith(...args);
  });
  it("rejects a cooldown other than 0, 5, 10 or 15", async () => {
    const c = ctx();
    expect(await dispatch("/thread --undo 7 hi", c)).toBe("keep");
    expect(c.print).toHaveBeenCalledWith("/thread: --undo must be 0, 5, 10 or 15", "error");
  });
  it.each([
    ["/reply 3", ["3", undefined]],
    ["/reply 3 thanks, that's it", ["3", "thanks, that's it"]],
  ])("%s", async (input, args) => {
    const c = ctx();
    await dispatch(input, c);
    expect(c.fake.reply).toHaveBeenCalledWith(...args);
  });
  it("needs a ref for /reply and /reply-from", async () => {
    const c = ctx();
    await dispatch("/reply", c);
    await dispatch("/reply-from", c);
    expect(c.print).toHaveBeenCalledWith("/reply: Usage: /reply <ref> [text]", "error");
    expect(c.print).toHaveBeenCalledWith("/reply-from: Usage: /reply-from <ref>", "error");
  });
  it("moves the cursor with /reply-from", async () => {
    const c = ctx();
    await dispatch("/reply-from A3", c);
    expect(c.fake.replyFrom).toHaveBeenCalledWith("A3");
  });
  it("keeps a /post's text exactly", async () => {
    const c = ctx();
    await dispatch("/post line one\nline two", c);
    await dispatch("/post", c);
    expect(c.fake.post).toHaveBeenNthCalledWith(1, "line one\nline two");
    expect(c.fake.post).toHaveBeenNthCalledWith(2, undefined);
  });
});

describe("session commands", () => {
  it.each([
    ["/auto-thread", undefined],
    ["/auto-thread on", true],
    ["/auto-thread off", false],
  ])("%s", async (input, value) => {
    const c = ctx();
    await dispatch(input, c);
    expect(c.fake.setAutoThread).toHaveBeenCalledWith(value);
  });
  it("/settings asks with no arguments and sets one directly", async () => {
    const c = ctx();
    await dispatch("/settings", c);
    expect(c.fake.askSettings).toHaveBeenCalled();
    await dispatch("/settings pace 10", c);
    expect(c.fake.setCooldown).toHaveBeenCalledWith("pace", 10);
    expect(c.print).toHaveBeenCalledWith("undo 5s · pace off · auto-thread off");
  });
  it("/history lists the session's posts", async () => {
    const c = ctx();
    await dispatch("/history", c);
    expect(c.print).toHaveBeenCalledWith('(1) 3lbx7kt5def2a "hello"');
  });
  it("/retry resends", async () => {
    const c = ctx();
    await dispatch("/retry", c);
    expect(c.fake.retry).toHaveBeenCalled();
  });
  it("/help lists every command", async () => {
    const c = ctx();
    await dispatch("/help", c);
    for (const name of ["help", "thread", "reply", "reply-from", "post", "auto-thread", "settings", "history", "retry", "exit"]) {
      expect(printed(c)).toContain(`/${name}`);
    }
  });
});
