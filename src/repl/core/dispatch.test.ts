import { describe, it, expect, vi } from "vitest";
import { dispatch, parseInput, TEXT_HINT } from "./dispatch";

const ctx = () => ({ print: vi.fn(), exit: vi.fn() });
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
  it("keeps plain text with a hint", async () => {
    const c = ctx();
    expect(await dispatch("hello", c)).toBe("keep");
    expect(c.print).toHaveBeenCalledWith(TEXT_HINT, "dim");
  });
});
