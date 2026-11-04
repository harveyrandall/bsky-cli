import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { App } from "./App";
import { offlineProps } from "@/repl";
import { IDLE_HINT, type Repl, type ReplSettings } from "@/repl/core/repl";
import { DEFAULT_MARKERS } from "@/repl/core/markers";
import type { AtUri, Cid, StrongRef } from "@/repl/core/types";

const { exit, suspendTerminal, editInEditor } = vi.hoisted(() => ({
  exit: vi.fn(),
  suspendTerminal: vi.fn(async (run: () => Promise<void>) => run()),
  editInEditor: vi.fn(async (text: string) => `${text} edited`),
}));
vi.mock("ink", async (importOriginal) => {
  const ink = await importOriginal<typeof import("ink")>();
  return { ...ink, useApp: () => ({ ...ink.useApp(), exit, suspendTerminal }) };
});
vi.mock("@/lib/editor", () => ({ editInEditor }));
beforeEach(() => {
  exit.mockClear();
  suspendTerminal.mockClear();
  editInEditor.mockClear();
});

const dir = mkdtempSync(join(tmpdir(), "bsky-app-"));
const image = join(dir, "chart.png");
const photo = join(dir, "photo.png");
const notes = join(dir, "notes.txt");
for (const file of [image, photo]) writeFileSync(file, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
writeFileSync(notes, "plain text");
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;
const RIGHT = "\x1b[C";

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
  const saveScheduled = vi.fn(async () => ({ id: "s1" }));
  const app = render(
    <App
      markers={DEFAULT_MARKERS}
      kittyHint={false}
      settings={{ ...offlineProps.settings, ...o.settings }}
      agent={agent}
      drafts={drafts}
      saveConfig={saveConfig}
      saveScheduled={saveScheduled}
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
  return { ...app, lastFrame, rawFrame: () => app.lastFrame() ?? "", type, agent, drafts, saveConfig, saveScheduled, repl: () => session! };
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
    expect(lastFrame()).toContain("Still working");
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
    await type("/re", "\t");
    expect(lastFrame()).toContain("/reply  /reply-from  /retry");
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
    expect(agent.post).toHaveBeenLastCalledWith("two", { parent: ref(1), root: ref(1) }, undefined, undefined);
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
    expect(lastFrame()).toContain("bsky › /post hello");
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
    expect(repl().pendingCount()).toBe(0);
  });
  it("asks before /exit leaves posts unsent", async () => {
    const { type, lastFrame } = setup({ settings: { pace: 10 } });
    await type("/post one", "\r");
    await tick();
    await type("/post two", "\r", "/exit", "\r");
    expect(exit).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("[s]end now · save [d]raft · discard [x] · [Esc] stay");
  });
  it("keeps what you're typing when a post comes back rejected, saving that post as a draft", async () => {
    const { type, lastFrame, agent, drafts } = setup();
    let reject = () => {};
    agent.post.mockImplementationOnce(
      () => new Promise((_resolve, fail) => (reject = () => fail(Object.assign(new Error("Invalid record"), { status: 400 })))),
    );
    await type("/post bad", "\r", "my next post");
    reject();
    await tick();
    await tick();
    expect(lastFrame()).toContain("bsky › my next post");
    expect(drafts.save).toHaveBeenCalledWith(expect.objectContaining({ reason: "manual", text: expect.stringContaining("bad") }));
  });
  it("stays put, with the queue intact, when the exit prompt can't save drafts", async () => {
    const { type, lastFrame, drafts, repl } = setup({ settings: { undo: 5 } });
    drafts.save.mockRejectedValueOnce(new Error("EACCES"));
    await type("/post hello", "\r", "\x04", "d");
    await tick();
    expect(exit).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("Couldn't save drafts (EACCES); still here");
    expect(repl().pendingCount()).toBe(1);
  });
  it("save draft keeps a queued thread a thread", async () => {
    const { type, drafts } = setup({ settings: { undo: 5 } });
    await type("/thread", "\r", "one /// two", "\r", "y");
    await tick();
    await type("\x04", "d");
    await tick();
    expect(drafts.save.mock.calls).toEqual([
      [{ reason: "manual", type: "thread", text: "one", posts: [{ text: "one" }, { text: "two" }] }],
    ]);
    expect(exit).toHaveBeenCalledOnce();
  });
  describe("while a post is in flight", () => {
    const inFlight = async (s: ReturnType<typeof setup>) => {
      const post: { finish(ref: StrongRef): void; fail(err: Error): void } = { finish() {}, fail() {} };
      s.agent.post.mockImplementationOnce(() => new Promise((resolve, reject) => Object.assign(post, { finish: resolve, fail: reject })));
      await s.type("/post hello", "\r");
      await tick();
      return post;
    };
    it("saves what's in the composer when you answer, not when you were asked", async () => {
      const s = setup();
      const post = await inFlight(s);
      await s.type("\x04");
      post.fail(Object.assign(new Error("Invalid record"), { status: 400 }));
      await tick();
      await s.type("d");
      await tick();
      expect(s.drafts.save).toHaveBeenCalledWith({ reason: "manual", type: "post", text: "hello" });
      expect(exit).toHaveBeenCalledOnce();
    });
    it("asks again if you typed something after choosing send now", async () => {
      const s = setup();
      const post = await inFlight(s);
      await s.type("\x04", "s", "more");
      post.finish(ref(1));
      await tick();
      await tick();
      expect(exit).not.toHaveBeenCalled();
      expect(s.lastFrame()).toContain("save [d]raft");
    });
    it("doesn't leave under an open question", async () => {
      const s = setup();
      const post = await inFlight(s);
      await s.type("\x04", "s", `/attach ${image}`, "\r");
      await tick();
      post.finish(ref(1));
      await tick();
      await tick();
      expect(exit).not.toHaveBeenCalled();
      expect(s.lastFrame()).toContain("Alt text for chart.png");
    });
    it("moves staged media into the draft on send now, so it isn't in both places", async () => {
      const s = setup();
      const post = await inFlight(s);
      await s.type(`/attach ${image}`, "\r");
      await tick();
      await s.type("\r");
      await tick();
      await s.type("\x04", "s");
      await tick();
      expect(s.drafts.save).toHaveBeenCalledWith(expect.objectContaining({ images: [image] }));
      expect(s.repl().staged()).toEqual([]);
      post.finish(ref(1));
      await tick();
      await tick();
      expect(exit).toHaveBeenCalledOnce();
    });
  });
  it("send now saves unsent composer text as a draft before leaving", async () => {
    const { type, drafts } = setup();
    await type("unsent", "\x04", "s");
    await tick();
    expect(drafts.save).toHaveBeenCalledWith({ reason: "manual", type: "post", text: "unsent" });
    expect(exit).toHaveBeenCalledOnce();
  });
  it("send now refuses while the queue is paused after an error", async () => {
    const { type, lastFrame, agent } = setup();
    agent.post.mockRejectedValueOnce(new Error("fetch failed"));
    await type("/post a", "\r");
    await tick();
    await type("unsent", "\x04", "s");
    expect(exit).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("Can't send now: the queue is paused after an error");
  });
  it("says what a pause needs: a retry after a network error, a login after an expired session", async () => {
    const offline = setup();
    offline.agent.post.mockRejectedValueOnce(new Error("fetch failed"));
    await offline.type("/post a", "\r");
    await tick();
    expect(offline.lastFrame()).toContain("Paused after a network error — /retry");
    const expired = setup();
    expired.agent.post.mockRejectedValueOnce(Object.assign(new Error("expired"), { status: 401 }));
    await expired.type("/post a", "\r");
    await tick();
    expect(expired.lastFrame()).toContain("Paused: session expired");
    expect(expired.lastFrame()).not.toContain("network error");
    const limited = setup();
    limited.agent.post.mockRejectedValueOnce(Object.assign(new Error("Rate Limit Exceeded"), { status: 429 }));
    await limited.type("/post a", "\r");
    await tick();
    expect(limited.lastFrame()).toContain("Paused: rate limited — /retry");
  });
  it("stays if a post comes back while it's sending everything to leave", async () => {
    const { type, lastFrame, agent } = setup({ settings: { undo: 5 } });
    agent.post.mockRejectedValueOnce(Object.assign(new Error("Invalid record"), { status: 400 }));
    await type("/post bad", "\r", "\x04", "s");
    await tick();
    await tick();
    expect(exit).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("bsky › /post bad");
  });
});

describe("App media", () => {
  const attached = async (s: ReturnType<typeof setup>) => {
    await s.type(`/attach ${image}`, "\r");
    await tick();
    await s.type("\r");
    await tick();
    return s;
  };
  it("asks for alt text, then shows the file above the composer", async () => {
    const { type, lastFrame, repl } = setup();
    await type(`/attach ${image}`, "\r");
    await tick();
    expect(lastFrame()).toContain("Alt text tells people using screen readers");
    expect(lastFrame()).toContain("Alt text for chart.png (Enter to skip):");
    await type("A bar chart");
    expect(lastFrame()).toContain("A bar chart");
    await type("\r");
    await tick();
    expect(lastFrame()).toContain("📎 chart.png");
    expect(repl().staged()).toEqual([{ path: image, kind: "image", alt: "A bar chart" }]);
  });
  it("says alt text is required with --force-alt, and Esc drops the file", async () => {
    const { type, lastFrame, repl } = setup({ settings: { forceAlt: true } });
    await type(`/attach ${image}`, "\r");
    await tick();
    expect(lastFrame()).toContain("Alt text for chart.png (required; Esc drops the file):");
    await type("\r");
    await tick();
    expect(lastFrame()).toContain("(required; Esc drops the file):");
    await type("\x1b");
    await tick();
    await tick();
    expect(repl().staged()).toEqual([]);
    expect(lastFrame()).not.toContain("📎");
  });
  it("sends staged media with the next post", async () => {
    const s = await attached(setup());
    await s.type("/post hello", "\r");
    await tick();
    expect(s.agent.post).toHaveBeenCalledWith("hello", undefined, [{ path: image, kind: "image" }], undefined);
    expect(s.lastFrame()).not.toContain("📎");
  });
  it("marks media in the preview", async () => {
    const s = await attached(setup());
    await s.type("/post a /// b", "\r");
    await tick();
    expect(s.lastFrame()).toContain("Post 2? [y/N]");
    expect(s.lastFrame().indexOf("📎 chart.png")).toBeLessThan(s.lastFrame().indexOf("── 2/2"));
  });
  it("asks before attaching a file dropped on an empty composer", async () => {
    const { type, lastFrame, repl } = setup();
    await type(paste(image));
    await tick();
    expect(lastFrame()).toContain("Attach chart.png? [Y/n]");
    await type("\r");
    await tick();
    await type("\r");
    await tick();
    expect(repl().staged().map((m) => m.path)).toEqual([image]);
  });
  it("counts several dropped files", async () => {
    const { type, lastFrame } = setup();
    await type(paste(`${image} ${photo}`));
    await tick();
    expect(lastFrame()).toContain("Attach chart.png and 1 more? [Y/n]");
  });
  it("pastes the path as text if you say no", async () => {
    const { type, lastFrame, repl } = setup();
    await type(paste(image));
    await tick();
    await type("n");
    await tick();
    expect(lastFrame()).toContain(`bsky › ${image}`.slice(0, 40));
    expect(repl().staged()).toEqual([]);
  });
  it("says why a dropped file is too big, rather than pasting its path", async () => {
    const big = join(dir, "phone.png");
    writeFileSync(big, new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new Array(1_000_000).fill(0)]));
    const { type, lastFrame, repl } = setup();
    await type(paste(big));
    await tick();
    expect(lastFrame()).toContain("Attach phone.png? [Y/n]");
    await type("\r");
    await tick();
    expect(lastFrame()).toContain("phone.png is over the 1 MB image limit");
    expect(lastFrame()).not.toContain(`bsky › ${dir}`.slice(0, 30));
    expect(repl().staged()).toEqual([]);
  });
  it("treats a path pasted into text as text", async () => {
    const { type, lastFrame } = setup();
    await type("see ", paste(image));
    await tick();
    expect(lastFrame()).not.toContain("Attach");
  });
  it("treats a path that isn't media as text", async () => {
    const { type, lastFrame } = setup();
    await type(paste(notes));
    await tick();
    await tick();
    expect(lastFrame()).not.toContain("Attach");
    expect(lastFrame()).toContain("bsky › ");
    expect(lastFrame().replace(/\s/g, "")).toContain(notes.replace(/\s/g, ""));
  });
  it("queues a question behind an open one rather than replacing it", async () => {
    const s = setup();
    let finish = (_: boolean) => {};
    vi.spyOn(s.repl(), "areMedia").mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await s.type(paste(image));
    await s.type("/new", "\r");
    await tick();
    finish(true);
    await tick();
    expect(s.lastFrame()).toContain("New:");
    expect(s.lastFrame()).not.toContain("Attach chart.png");
    await s.type("\x1b");
    await tick();
    expect(s.lastFrame()).toContain("Attach chart.png? [Y/n]");
    await s.type("n");
    await tick();
    await s.type("\x15", "/exit", "\r");
    await tick();
    expect(exit).toHaveBeenCalledOnce();
  });
  it("hands the composer's text to $EDITOR on Ctrl+G and puts the result back", async () => {
    const { type, lastFrame } = setup();
    await type("draft", "\x07");
    await tick();
    expect(suspendTerminal).toHaveBeenCalledOnce();
    expect(editInEditor).toHaveBeenCalledWith("draft");
    expect(lastFrame()).toContain("bsky › draft edited");
  });
  it("does the same with /edit", async () => {
    const { type, lastFrame } = setup();
    await type("/edit draft", "\r");
    await tick();
    expect(suspendTerminal).toHaveBeenCalledOnce();
    expect(lastFrame()).toContain("bsky › draft edited");
    expect(lastFrame()).not.toContain("/edit");
  });
  it("holds back what happens while $EDITOR is open, and keeps a post that comes back", async () => {
    let closeEditor = (_: string) => {};
    editInEditor.mockImplementationOnce(() => new Promise((resolve) => (closeEditor = resolve)));
    let reject = (_: Error) => {};
    const { type, lastFrame, agent, drafts } = setup();
    agent.post.mockImplementationOnce(() => new Promise((_, r) => (reject = r)));
    await type("/post bad", "\r");
    await tick();
    await type("\x07");
    await tick();
    reject(Object.assign(new Error("Invalid record"), { status: 400 }));
    await tick();
    expect(lastFrame()).not.toContain("Invalid record");
    closeEditor("my words");
    await tick();
    expect(lastFrame()).toContain("Invalid record");
    expect(lastFrame()).toContain("bsky › my words");
    expect(lastFrame()).toContain("A post came back while you were typing; saved it as draft d1");
    expect(drafts.save).toHaveBeenCalledWith({ reason: "manual", type: "post", text: "bad" });
  });
  it("reports an editor that won't start and keeps the text", async () => {
    editInEditor.mockRejectedValueOnce(new Error("Couldn't open nano: ENOENT"));
    const { type, lastFrame } = setup();
    await type("draft", "\x07");
    await tick();
    expect(lastFrame()).toContain("Couldn't open nano");
    expect(lastFrame()).toContain("bsky › draft");
  });
  it("walks /new through to a saved draft", async () => {
    const { type, lastFrame, drafts } = setup();
    await type("/new", "\r");
    await tick();
    expect(lastFrame()).toContain("Post");
    expect(lastFrame()).toContain("Scheduled post");
    await type(RIGHT, RIGHT, RIGHT, RIGHT, RIGHT, RIGHT, "\r");
    await tick();
    expect(lastFrame()).toContain("draft ›");
    await type("for later", "\r");
    await tick();
    expect(drafts.save).toHaveBeenCalledWith({ reason: "manual", type: "post", text: "for later" });
    expect(lastFrame()).toContain("Saved as draft d1");
  });
  it("walks /new through to a scheduled post", async () => {
    const { type, lastFrame, saveScheduled } = setup();
    await type("/new", "\r");
    await tick();
    await type(RIGHT, RIGHT, RIGHT, RIGHT, RIGHT, "\r");
    await tick();
    await type("later on", "\r");
    await tick();
    expect(lastFrame()).toContain("Date (DD-MM or DD-MM-YYYY):");
    await type("31-12-2099", "\r");
    await tick();
    expect(lastFrame()).toContain("Time (HH:MM):");
    expect(lastFrame()).not.toContain("31-12-2099");
    await type("15:30", "\r");
    await tick();
    expect(saveScheduled).toHaveBeenCalledWith({ scheduledAt: new Date(2099, 11, 31, 15, 30).toISOString(), text: "later on" });
    expect(lastFrame()).toContain("Scheduled for 31 Dec 2099, 15:30 (s1)");
  });
  it("starts the pace question at its first option, whatever undo was", async () => {
    const { type, lastFrame } = setup({ settings: { undo: undefined, pace: undefined } });
    await type("/thread", "\r");
    await tick();
    await type(RIGHT, "\r");
    await tick();
    expect(lastFrame()).toContain("› none");
  });
  it("starts each picker at its first option", async () => {
    const { type, lastFrame } = setup();
    await type("/new", "\r");
    await tick();
    await type(RIGHT, RIGHT, RIGHT, RIGHT, RIGHT, "\r");
    await tick();
    await type("later on", "\r");
    await tick();
    await type("31-12-2099", "\r");
    await tick();
    await type("3:30", "\r");
    await tick();
    expect(lastFrame()).toContain("› AM");
  });
});
