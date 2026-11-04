import { stripVTControlCharacters } from "node:util";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { App } from "./App";
import { offlineProps } from "@/repl";
import { IDLE_HINT, type Repl, type ReplSettings } from "@/repl/core/repl";
import { DEFAULT_MARKERS } from "@/repl/core/markers";
import type { AtUri, Cid, StrongRef } from "@/repl/core/types";

const { exit } = vi.hoisted(() => ({ exit: vi.fn() }));
vi.mock("ink", async (importOriginal) => {
  const ink = await importOriginal<typeof import("ink")>();
  return { ...ink, useApp: () => ({ ...ink.useApp(), exit }) };
});
beforeEach(() => exit.mockClear());

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const ref = (n: number): StrongRef => ({
  uri: `at://did:plc:me/app.bsky.feed.post/3lbx7kt5def${String.fromCharCode(97 + n)}a` as AtUri,
  cid: `bafy${n}` as Cid,
});

function setup(o: { settings?: Partial<ReplSettings> } = {}) {
  let session: Repl | undefined;
  let n = 0;
  const agent = {
    selfDid: "did:plc:me" as const,
    resolveHandle: vi.fn(),
    getPosts: vi.fn(async () => []),
    post: vi.fn(async () => ref(++n)),
  };
  const drafts = { save: vi.fn(async () => ({ id: "d1" })), delete: vi.fn(async () => {}) };
  const saveConfig = vi.fn(async () => {});
  const app = render(
    <App
      markers={DEFAULT_MARKERS}
      kittyHint={false}
      settings={{ ...offlineProps.settings, ...o.settings }}
      agent={agent}
      drafts={drafts}
      saveConfig={saveConfig}
      configName="config.toml"
      onReady={(r) => (session = r)}
    />,
  );
  // A fixed height, so results don't depend on the terminal running the tests.
  Object.defineProperty(app.stdout, "rows", { value: 24, configurable: true });
  app.stdout.emit("resize");
  const type = async (...chunks: string[]) => {
    for (const chunk of chunks) { app.stdin.write(chunk); await tick(); }
  };
  // Colour codes depend on the terminal running the tests.
  const lastFrame = () => stripVTControlCharacters(app.lastFrame() ?? "");
  return { ...app, lastFrame, rawFrame: () => app.lastFrame() ?? "", type, agent, drafts, saveConfig, repl: () => session! };
}

describe("App", () => {
  it("keeps plain text with a hint on Enter", async () => {
    const { type, lastFrame } = setup();
    await type("hello", "\r");
    // The hint wraps at the test terminal's 100 columns.
    expect(lastFrame().replace(/\n/g, " ")).toContain(IDLE_HINT);
    expect(lastFrame()).toContain("bsky › hello");
  });
  it("Ctrl+C in the same chunk as typed text still clears it", async () => {
    const { type, lastFrame } = setup();
    await type("abc\x03");
    expect(lastFrame()).not.toContain("abc");
  });
  it("Ctrl+U in the same chunk as typed text deletes it", async () => {
    const { type, lastFrame } = setup();
    await type("abc\x15");
    expect(lastFrame()).not.toContain("abc");
  });
  it("Enter at the end of a typed chunk submits", async () => {
    const { type, lastFrame } = setup();
    await type("/help\r");
    expect(lastFrame()).toContain("Leave the REPL");
  });
  it("an unbracketed multi-line chunk keeps its newlines", async () => {
    const { type, lastFrame } = setup();
    await type("a\rb\r");
    expect(lastFrame()).toMatch(/bsky › a\n\s+b/);
    expect(lastFrame()).not.toContain(IDLE_HINT);
  });
  it("a paste drops escape sequences and control bytes", async () => {
    const { type, lastFrame, rawFrame } = setup();
    await type("\x1b[200~a\x1b[31mb\x1b[0m\x07c\x1b[201~");
    expect(rawFrame()).not.toMatch(/\x1b\[31m|\x07/);
    expect(lastFrame()).toContain("bsky › abc");
  });
  it("keeps keys typed right after Enter and records what ran", async () => {
    const { type, lastFrame } = setup();
    await type("/help");
    await type("\r\x1b[Dx");
    expect(lastFrame()).toContain("Leave the REPL");
    expect(lastFrame()).toContain("bsky › /helxp");
    await type("\x1b[A");
    expect(lastFrame()).toMatch(/^bsky › \/help\s*$/m);
  });
  it("ignores a second Enter while a submit is running", async () => {
    const { type, lastFrame } = setup();
    await type("/help");
    await type("\r\x1b[C\r");
    expect(lastFrame().split("Leave the REPL")).toHaveLength(2);
    expect(lastFrame()).toContain("Still sending");
  });
  it("shows only the lines around the cursor when the draft is taller than the window", async () => {
    const app = setup();
    Object.defineProperty(app.stdout, "rows", { value: 8, configurable: true });
    app.stdout.emit("resize");
    await tick();
    const draft = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n");
    await app.type(`\x1b[200~${draft}\x1b[201~`);
    expect(app.lastFrame()).toContain("↑ 16 more lines");
    expect(app.lastFrame()).toMatch(/^\s+l20/m);
    expect(app.lastFrame()).not.toMatch(/^\s+l5\s*$/m);
    await app.type("\x1b[A".repeat(10));
    expect(app.lastFrame()).toMatch(/^\s+l10/m);
    expect(app.lastFrame()).toContain("↑ 8 more lines");
    expect(app.lastFrame()).toContain("↓ 8 more lines");
    expect(app.lastFrame()).not.toMatch(/^\s+l20/m);
  });
  it("keeps a long wrapped paragraph inside the window", async () => {
    const app = setup();
    Object.defineProperty(app.stdout, "rows", { value: 8, configurable: true });
    app.stdout.emit("resize");
    await tick();
    await app.type(`\x1b[200~${"word ".repeat(500)}\x1b[201~`);
    const belowHeader = app.lastFrame().split("\n").slice(1);
    expect(belowHeader.length).toBeLessThan(8);
    expect(app.lastFrame()).toContain("more lines");
  });
  it("submits again once the first submit has finished", async () => {
    const { type, lastFrame } = setup();
    await type("/hlp", "\r", "\x15", "/help", "\r");
    expect(lastFrame()).toContain("Leave the REPL");
  });
  it.each([
    ["/exit", ["/exit", "\r"]],
    ["Ctrl+D on an empty composer", ["\x04"]],
  ])("%s leaves the REPL", async (_name, chunks) => {
    const { type } = setup();
    await type(...chunks);
    expect(exit).toHaveBeenCalledOnce();
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
    expect(lastFrame()).not.toContain(IDLE_HINT);
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
  it("stores a pasted CRLF as one newline", async () => {
    const { type, lastFrame } = setup();
    await type("\x1b[200~a\r\nb\x1b[201~");
    expect(lastFrame()).toContain("○ 3/300");
  });
  it("lists the candidates when Tab can't extend the name", async () => {
    const { type, lastFrame } = setup();
    await type("/", "\t");
    expect(lastFrame()).toContain("/auto-thread  /exit  /help  /history  /post");
  });
});

describe("App threads", () => {
  it("writes a thread end to end through the keyboard", async () => {
    const { type, lastFrame, agent } = setup();
    await type("/thread", "\r");
    expect(lastFrame()).toMatch(/^thread ›\s*$/m);
    await type("one", "\r");
    await tick();
    expect(lastFrame()).toContain("(1) 3lbx7kt5defba");
    expect(lastFrame()).toMatch(/^thread \(1\) ›\s*$/m);
    await type("two", "\r");
    await tick();
    expect(agent.post).toHaveBeenLastCalledWith("two", { parent: ref(1), root: ref(1) });
  });
  it("previews a split and posts it on y", async () => {
    const { type, lastFrame, agent } = setup();
    await type("/thread", "\r", "a /// b", "\r");
    expect(lastFrame()).toContain("Post 2? [y/N]");
    await type("y");
    await tick();
    expect(agent.post).toHaveBeenCalledTimes(2);
  });
  it("puts the text back when the preview is declined", async () => {
    const { type, lastFrame, agent } = setup();
    await type("/thread", "\r", "a /// b", "\r", "\r");
    expect(lastFrame()).not.toContain("[y/N]");
    expect(lastFrame()).toContain("thread › a /// b");
    expect(agent.post).not.toHaveBeenCalled();
  });
  it("counts down the undo window and cancels on Esc, text back in the composer", async () => {
    const { type, lastFrame, agent } = setup({ settings: { undo: 5 } });
    await type("/post hello", "\r");
    expect(lastFrame()).toContain("Sending in 5s… [Esc] cancel  [Enter] send now");
    // The waiting post shows, read-only, in place of the composer.
    expect(lastFrame()).toMatch(/^bsky › hello\s*$/m);
    await type("more");
    expect(lastFrame()).not.toContain("more");
    await type("\x1b");
    await tick();
    expect(lastFrame()).not.toContain("Sending in");
    expect(lastFrame()).toContain("bsky › hello");
    expect(agent.post).not.toHaveBeenCalled();
  });
  it("asks for undo and pace on the first thread, then saves them on Yes", async () => {
    const { type, lastFrame, saveConfig } = setup({ settings: { undo: undefined, pace: undefined, askToSave: true } });
    await type("/thread", "\r");
    expect(lastFrame()).toContain("Undo window before each post?");
    await type("\x1b[C", "\r");
    expect(lastFrame()).toContain("Minimum time between posts?");
    await type("\r");
    expect(lastFrame()).toContain("Save undo 5s · pace off as your defaults in config.toml?");
    await type("\r");
    expect(saveConfig).toHaveBeenCalledWith({ undo: 5, pace: 0 });
    expect(lastFrame()).toMatch(/^thread ›\s*$/m);
  });
  it("asks what to do on Ctrl+D with unsent text, and leaves on x", async () => {
    const { type, lastFrame } = setup();
    await type("unsent", "\x04");
    expect(lastFrame()).toContain("[s]end now · save [d]raft · discard [x] · [Esc] stay");
    await type("x");
    expect(exit).toHaveBeenCalledOnce();
  });
  it("saves the composer text as a draft on d, then leaves", async () => {
    const { type, drafts } = setup();
    await type("unsent", "\x04", "d");
    await tick();
    expect(drafts.save).toHaveBeenCalledWith({ reason: "manual", type: "post", text: "unsent" });
    expect(exit).toHaveBeenCalledOnce();
  });
  it("leaves nothing queued when you discard and exit", async () => {
    const { type, repl } = setup({ settings: { undo: 5 } });
    await type("/post hello", "\r", "\x04", "x");
    expect(exit).toHaveBeenCalledOnce();
    expect(repl().pipeline.pending()).toEqual([]);
  });
  it("asks before /exit leaves posts unsent", async () => {
    const { type, lastFrame } = setup({ settings: { pace: 10 } });
    await type("/post one", "\r");
    await tick();
    await type("/post two", "\r", "/exit", "\r");
    expect(exit).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("[s]end now · save [d]raft · discard [x] · [Esc] stay");
  });
});
