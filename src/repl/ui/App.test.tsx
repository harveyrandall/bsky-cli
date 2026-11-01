import { stripVTControlCharacters } from "node:util";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { App } from "./App";
import { TEXT_HINT } from "@/repl/core/dispatch";
import { DEFAULT_MARKERS } from "@/repl/core/markers";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
function setup() {
  const app = render(<App markers={DEFAULT_MARKERS} kittyHint={false} />);
  const type = async (...chunks: string[]) => {
    for (const chunk of chunks) { app.stdin.write(chunk); await tick(); }
  };
  // Colour codes depend on the terminal running the tests.
  const lastFrame = () => stripVTControlCharacters(app.lastFrame() ?? "");
  return { ...app, lastFrame, type };
}

describe("App", () => {
  it("keeps plain text with a hint on Enter", async () => {
    const { type, lastFrame } = setup();
    await type("hello", "\r");
    expect(lastFrame()).toContain(TEXT_HINT);
    expect(lastFrame()).toContain("bsky › hello");
  });
  it("Ctrl+C in the same chunk as typed text still clears it", async () => {
    const { type, lastFrame } = setup();
    await type("abc\x03");
    expect(lastFrame()).not.toContain("abc");
  });
  it("runs /help and clears the composer", async () => {
    const { type, lastFrame } = setup();
    await type("/help", "\r");
    expect(lastFrame()).toContain("/exit");
    expect(lastFrame()).not.toContain("bsky › /help");
  });
  it("suggests a command and keeps the text", async () => {
    const { type, lastFrame } = setup();
    await type("/hlp", "\r");
    expect(lastFrame()).toContain("Unknown /hlp. Did you mean /help?");
    expect(lastFrame()).toContain("bsky › /hlp");
  });
  it.each([
    ["Shift+Enter (kitty)", ["a", "\x1b[13;2u", "b"]],
    ["Alt+Enter", ["a", "\x1b\r", "b"]],
    ["Ctrl+J", ["a", "\n", "b"]],
    ["trailing backslash", ["a\\", "\r", "b"]],
    ["bracketed paste", ["\x1b[200~a\r\nb\x1b[201~"]],
  ])("%s inserts a newline without submitting", async (_name, chunks) => {
    const { type, lastFrame } = setup();
    await type(...chunks);
    expect(lastFrame()).toMatch(/bsky › a\n\s+b/);
    expect(lastFrame()).not.toContain(TEXT_HINT);
  });
  it("shows the ring for the segment under the cursor", async () => {
    const { type, lastFrame } = setup();
    await type("one /// two");
    expect(lastFrame()).toContain("segment 2/2  ○ 3/300");
  });
  it("Ctrl+C clears the text, then hints at Ctrl+D", async () => {
    const { type, lastFrame } = setup();
    await type("abc", "\x03");
    expect(lastFrame()).not.toContain("abc");
    await type("\x03");
    // The header says it too, so count: header + hint.
    expect(lastFrame().split("Ctrl+D to exit")).toHaveLength(3);
  });
  it("Tab completes a command name", async () => {
    const { type, lastFrame } = setup();
    await type("/he", "\t");
    expect(lastFrame()).toContain("bsky › /help");
  });
});
