import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Repl, IDLE_HINT, type ReplAsk, type ReplSettings } from "./repl";
import { DEFAULT_MARKERS } from "./markers";
import type { AtUri, Cid, Did, StrongRef } from "./types";
import type { SendTarget } from "./pipeline";
import type { LineStyle } from "./commands";

const me = "did:plc:me" as Did;
const ref = (n: number): StrongRef => ({
  uri: `at://${me}/app.bsky.feed.post/3lbx7kt5def${String.fromCharCode(97 + n)}a` as AtUri,
  cid: `bafy${n}` as Cid,
});

const rejected = () => Object.assign(new Error("Invalid record"), { status: 400 });

function setup(settings: Partial<ReplSettings> = {}, answers: Partial<ReplAsk> = {}) {
  let n = 0;
  const posted: { text: string; reply?: SendTarget }[] = [];
  const agent = {
    selfDid: me,
    resolveHandle: vi.fn(async () => me),
    getPosts: vi.fn(async () => []),
    post: vi.fn(async (text: string, reply?: SendTarget) => {
      posted.push({ text, reply });
      return ref(++n);
    }),
  };
  const ask: ReplAsk = {
    cooldown: vi.fn(async () => 0 as const),
    saveOffer: vi.fn(async () => "no" as const),
    confirm: vi.fn(async () => true),
    ...answers,
  };
  const lines: [string, LineStyle | undefined][] = [];
  const deps = {
    agent,
    ask,
    print: (text: string, style?: LineStyle) => void lines.push([text, style]),
    onChange: vi.fn(),
    restore: vi.fn(),
    saveDraft: vi.fn(async () => ({ id: "d1" })),
    deleteDraft: vi.fn(async () => {}),
    saveConfig: vi.fn(async () => {}),
  };
  const repl = new Repl(
    { autoThread: false, prefixThread: false, threadLabel: false, undo: 0, pace: 0, askToSave: true, verbose: false, ...settings },
    DEFAULT_MARKERS,
    deps,
  );
  const flush = () => vi.advanceTimersByTimeAsync(0);
  const printed = () => lines.map(([t]) => t).join("\n");
  return { repl, agent, ask, deps, lines, posted, flush, printed };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-04T10:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("idle", () => {
  it("keeps plain text with a hint", async () => {
    const { repl, agent, lines } = setup();
    expect(await repl.submitText("hello")).toBe("keep");
    expect(lines).toContainEqual([IDLE_HINT, "dim"]);
    expect(agent.post).not.toHaveBeenCalled();
    expect(repl.prompt()).toBe("bsky ›");
  });
  it("starts a thread from plain text with auto-thread", async () => {
    const { repl, posted, flush } = setup({ autoThread: true });
    expect(await repl.submitText("hello")).toBe("done");
    await flush();
    expect(posted).toEqual([{ text: "hello", reply: undefined }]);
    expect(repl.mode().kind).toBe("thread");
  });
});

describe("threads", () => {
  it("writes a thread end to end, moving the cursor each time", async () => {
    const { repl, posted, flush, printed } = setup();
    await repl.startThread();
    expect(repl.prompt()).toBe("thread ›");
    await repl.submitText("one");
    await flush();
    expect(repl.prompt()).toBe("thread (1) ›");
    await repl.submitText("two");
    await flush();
    expect(posted[1].reply).toEqual({ parent: ref(1), root: ref(1) });
    expect(repl.prompt()).toBe("thread (2) ›");
    expect(printed()).toContain(`(1) ${ref(1).uri.split("/").pop()}`);
  });
  it("letters threads in prefixed mode", async () => {
    const { repl, flush } = setup({ prefixThread: true });
    await repl.startThread("one");
    await flush();
    expect(repl.prompt()).toBe("thread A (A1) ›");
  });
  it("replies once, then returns to the thread with the cursor unchanged", async () => {
    const { repl, posted, flush } = setup();
    await repl.startThread("one");
    await flush();
    await repl.submitText("two");
    await flush();
    await repl.reply("1");
    expect(repl.prompt()).toBe("reply→1 ›");
    await repl.submitText("branch");
    await flush();
    expect(posted[2].reply).toEqual({ parent: ref(1), root: ref(1) });
    expect(repl.prompt()).toBe("thread (2) ›");
  });
  it("replies with text straight away", async () => {
    const { repl, posted, flush } = setup();
    await repl.post("solo");
    await flush();
    await repl.reply("1", "hi");
    await flush();
    expect(posted[1]).toEqual({ text: "hi", reply: { parent: ref(1), root: ref(1) } });
    expect(repl.mode().kind).toBe("idle");
  });
  it("moves the cursor with replyFrom", async () => {
    const { repl, posted, flush } = setup();
    await repl.startThread("one");
    await flush();
    await repl.submitText("two");
    await flush();
    await repl.replyFrom("1");
    await repl.submitText("three");
    await flush();
    expect(posted[2].reply).toEqual({ parent: ref(1), root: ref(1) });
    expect(repl.prompt()).toBe("thread (3) ›");
  });
  it.each([
    ["a ref continues that thread", "1", {}, 1],
    ["quoted text is posted", "1", { asText: true }, 2],
    ["other text starts a thread with it", "hello world", {}, 2],
  ])("/thread argument forms: %s", async (_name, arg, opts, posts) => {
    const { repl, posted, flush } = setup();
    await repl.post("solo");
    await flush();
    await repl.startThread(arg, opts);
    await flush();
    expect(posted).toHaveLength(posts);
    expect(repl.mode().kind).toBe("thread");
    if (posts === 1) expect(repl.prompt()).toBe("thread (1) ›");
    else expect(posted[1]).toEqual({ text: arg, reply: undefined });
  });
  it("stops a thread on Esc with an empty composer", async () => {
    const { repl, flush, printed } = setup();
    await repl.startThread("one");
    await flush();
    await repl.submitText("two");
    await flush();
    expect(repl.escape("")).toBe("handled");
    expect(printed()).toContain(`Thread stopped (2 posts, root (1) ${ref(1).uri.split("/").pop()!.slice(0, 4)}…)`);
    expect(repl.mode().kind).toBe("idle");
  });
});

describe("puts text back", () => {
  it("when the preview is declined", async () => {
    const { repl, agent } = setup({}, { confirm: vi.fn(async () => false) });
    await repl.startThread();
    expect(await repl.submitText("a /// b")).toBe("keep");
    expect(agent.post).not.toHaveBeenCalled();
  });
  it("keeps the whole command, not just its text, when a preview is declined", async () => {
    const { repl } = setup({}, { confirm: vi.fn(async () => false) });
    expect(await repl.post("a /// b")).toBe("keep");
    expect(await repl.reply(ref(0).uri, "a /// b")).toBe("keep");
  });
  it("stays in reply-once mode when the preview is declined", async () => {
    const { repl, flush } = setup({}, { confirm: vi.fn(async () => false) });
    await repl.post("first");
    await flush();
    await repl.reply("1");
    expect(await repl.submitText("a /// b")).toBe("keep");
    expect(repl.mode().kind).toBe("reply-once");
  });
  it("as a /post when the server rejects a post on its own", async () => {
    const { repl, agent, deps, flush } = setup();
    agent.post.mockRejectedValueOnce(rejected());
    await repl.post("bad");
    await flush();
    expect(deps.restore).toHaveBeenCalledWith("/post bad");
  });
  it("as a /reply when the server rejects a reply", async () => {
    const { repl, agent, deps, flush } = setup();
    await repl.post("first");
    await flush();
    agent.post.mockRejectedValueOnce(rejected());
    await repl.reply("1", "bad");
    await flush();
    expect(deps.restore).toHaveBeenCalledWith("/reply 1 bad");
  });
  it("as a reply to the last post sent when a later post of a batch is rejected", async () => {
    const { repl, agent, deps, flush } = setup();
    agent.post.mockResolvedValueOnce(ref(1)).mockRejectedValueOnce(rejected());
    await repl.post("one /// bad /// three");
    await flush();
    expect(deps.restore).toHaveBeenCalledWith("/reply 1 bad /// three");
  });
  it("as plain text when a thread post is rejected in that thread", async () => {
    const { repl, agent, deps, flush } = setup();
    await repl.startThread();
    await repl.submitText("first");
    await flush();
    agent.post.mockRejectedValueOnce(rejected());
    await repl.submitText("bad");
    await flush();
    expect(deps.restore).toHaveBeenCalledWith("bad");
  });
  it("as a /thread when the first post is rejected after you've moved on", async () => {
    const { repl, agent, deps, flush } = setup();
    let reject = (_: Error) => {};
    agent.post.mockImplementationOnce(() => new Promise((_, r) => (reject = r)));
    await repl.startThread("bad");
    await flush();
    await repl.post();
    reject(rejected());
    await flush();
    expect(deps.restore).toHaveBeenCalledWith("/thread bad");
  });
  it("when pending posts are cancelled with an empty composer", async () => {
    const { repl } = setup({ undo: 5 });
    await repl.post("waiting");
    expect(repl.escape("")).toEqual({ restore: "waiting" });
  });
  it("saves cancelled posts as a draft when the composer has text", async () => {
    const { repl, deps, flush, printed } = setup({ undo: 5 });
    await repl.post("waiting");
    expect(repl.escape("new text")).toBe("handled");
    await flush();
    expect(deps.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ reason: "manual", text: "waiting" }));
    expect(printed()).toContain("Saved as draft d1");
  });
});

describe("draft saves that fail", () => {
  it("print the cancelled text instead of crashing", async () => {
    const { repl, deps, flush, printed } = setup({ undo: 5 });
    deps.saveDraft.mockRejectedValueOnce(new Error("EACCES"));
    await repl.post("waiting");
    expect(repl.escape("new text")).toBe("handled");
    await flush();
    expect(printed()).toContain("Couldn't save the cancelled posts as a draft (EACCES):");
    expect(printed()).toContain("waiting");
  });
});

describe("submit", () => {
  it("previews anything that isn't one plain post", async () => {
    const { repl, ask, flush, posted } = setup();
    await repl.startThread();
    await repl.submitText("a /// b //> later");
    expect(ask.confirm).toHaveBeenCalledWith(expect.objectContaining({ posts: ["a", "b"], keep: "later" }), false);
    await flush();
    expect(posted.map((p) => p.text)).toEqual(["a", "b"]);
  });
  it("returns kept text and prints discarded text once", async () => {
    const { repl, lines } = setup();
    await repl.startThread();
    expect(await repl.submitText("a <// scrap //> later")).toEqual({ restore: "later" });
    expect(lines).toContainEqual(["Discarded: scrap", "dim"]);
  });
  it("refuses a marker-made post over the limit", async () => {
    const { repl, ask, printed } = setup();
    await repl.startThread();
    const text = `short /// ${"y".repeat(320)}`;
    expect(await repl.submitText(text)).toBe("keep");
    expect(ask.confirm).not.toHaveBeenCalled();
    expect(printed()).toContain("Post 2 is 320/300");
  });
  it("labels posts in the active thread and reserves room for the label", async () => {
    const { repl, posted, flush } = setup({ threadLabel: "append" });
    expect(repl.composerLimit()).toBe(300);
    await repl.startThread("one");
    await flush();
    expect(repl.composerLimit()).toBe(298);
    await repl.post("solo");
    await flush();
    expect(posted.map((p) => p.text)).toEqual(["one\n🧵", "solo"]);
  });
  it("labels a reply in the active thread, whichever way it was typed", async () => {
    const { repl, posted, flush } = setup({ threadLabel: "append" });
    await repl.startThread("one");
    await flush();
    await repl.reply("1", "now");
    await flush();
    await repl.reply("1");
    expect(repl.composerLimit()).toBe(298);
    await repl.submitText("later");
    await flush();
    expect(posted.map((p) => p.text)).toEqual(["one\n🧵", "now\n🧵", "later\n🧵"]);
  });
  it("doesn't label a post on its own, even mid-thread", async () => {
    const { repl, flush } = setup({ threadLabel: "append" });
    await repl.startThread("one");
    await flush();
    await repl.post();
    expect(repl.composerLimit()).toBe(300);
  });
  it("reserves room for the label when plain text will start a thread", async () => {
    const { repl } = setup({ threadLabel: "append", autoThread: true });
    expect(repl.composerLimit()).toBe(298);
  });
  it("prepends the label when asked", async () => {
    const { repl, posted, flush } = setup({ threadLabel: "prepend" });
    await repl.startThread("one");
    await flush();
    expect(posted[0].text).toBe("🧵\none");
  });
});

describe("once modes", () => {
  it("go back to the thread even when one replaces another", async () => {
    const { repl, flush } = setup();
    await repl.startThread("one");
    await flush();
    await repl.post();
    await repl.reply("1");
    await repl.submitText("hi");
    await flush();
    expect(repl.mode().kind).toBe("thread");
    await repl.reply("1");
    await repl.post();
    expect(repl.escape("")).toBe("handled");
    expect(repl.mode().kind).toBe("thread");
  });
});

describe("cooldowns", () => {
  it("asks for undo and pace on the first thread, then offers to save them", async () => {
    const answers = [5, 0];
    const { repl, ask, deps } = setup(
      { undo: undefined, pace: undefined },
      { cooldown: vi.fn(async () => answers.shift() as 0 | 5), saveOffer: vi.fn(async () => "yes" as const) },
    );
    await repl.startThread();
    expect(ask.cooldown).toHaveBeenNthCalledWith(1, "undo");
    expect(ask.cooldown).toHaveBeenNthCalledWith(2, "pace");
    expect(ask.saveOffer).toHaveBeenCalledWith({ undo: 5, pace: 0 });
    expect(deps.saveConfig).toHaveBeenCalledWith({ undo: 5, pace: 0 });
    repl.escape("");
    await repl.startThread();
    expect(ask.cooldown).toHaveBeenCalledTimes(2);
  });
  it("only asks for what isn't configured, and remembers 'don't ask again'", async () => {
    const { repl, ask, deps } = setup({ undo: 5, pace: undefined }, { saveOffer: vi.fn(async () => "never" as const) });
    await repl.startThread();
    expect(ask.cooldown).toHaveBeenCalledExactlyOnceWith("pace");
    expect(ask.saveOffer).toHaveBeenCalledWith({ pace: 0 });
    expect(deps.saveConfig).toHaveBeenCalledWith({ "ask-to-save": false });
  });
  it("doesn't offer to save when ask-to-save is off", async () => {
    const { repl, ask } = setup({ undo: undefined, pace: undefined, askToSave: false });
    await repl.startThread();
    expect(ask.saveOffer).not.toHaveBeenCalled();
  });
  it("cancels the thread when a question is dismissed", async () => {
    const { repl } = setup({ undo: undefined }, { cooldown: vi.fn(async () => undefined) });
    expect(await repl.startThread("hello")).toBe("keep");
    expect(repl.mode().kind).toBe("idle");
  });
});

describe("pending posts", () => {
  it("block commands that move the cursor", async () => {
    const { repl, printed } = setup({ undo: 5 });
    await repl.startThread("one");
    expect(await repl.startThread()).toBe("keep");
    await repl.replyFrom("1");
    expect(printed()).toContain("Wait for pending posts, or Esc to cancel them");
  });
  it("include a paused failure, even once its posts are in a draft", async () => {
    const { repl, agent, flush, printed } = setup();
    agent.post.mockRejectedValueOnce(new Error("fetch failed"));
    await repl.startThread("one");
    await flush();
    expect(await repl.startThread()).toBe("keep");
    expect(printed()).toContain("Wait for pending posts, or Esc to cancel them");
  });
});

describe("a paused failure", () => {
  const paused = async (failure: Error = new Error("fetch failed")) => {
    const s = setup();
    s.agent.post.mockRejectedValueOnce(failure);
    await s.repl.post("one");
    await s.flush();
    return s;
  };
  it("is cleared by Esc, which leaves its draft in place", async () => {
    const { repl, deps, printed } = await paused();
    expect(repl.escape("")).toBe("handled");
    expect(printed()).toContain("Left in draft d1");
    expect(deps.deleteDraft).not.toHaveBeenCalled();
    await repl.retry();
    expect(printed()).toContain("Nothing to retry");
  });
  it("is cleared by Ctrl+C too", async () => {
    const { repl } = await paused();
    expect(repl.interrupt("text")).toBe("handled");
    expect(repl.interrupt("")).toBe("hint");
  });
  it("loses nothing on exit once it's in a draft", async () => {
    const { repl } = await paused();
    expect(repl.wouldLose("")).toBe(false);
  });
  it("doesn't claim a draft that couldn't be saved when the session expires", async () => {
    const s = setup();
    s.deps.saveDraft.mockRejectedValueOnce(new Error("EACCES"));
    s.agent.post.mockRejectedValueOnce(Object.assign(new Error("expired"), { status: 401 }));
    await s.repl.post("one");
    await s.flush();
    expect(s.printed()).not.toContain("draft undefined");
    expect(s.printed()).toContain("EACCES");
    expect(s.repl.wouldLose("")).toBe(true);
  });
});

describe("keys", () => {
  it("routes Esc and Ctrl+C by layer", async () => {
    const { repl, flush } = setup();
    expect(repl.escape("")).toBe("unhandled");
    expect(repl.interrupt("text")).toBe("clear");
    expect(repl.interrupt("")).toBe("hint");
    await repl.post();
    expect(repl.prompt()).toBe("post ›");
    expect(repl.escape("")).toBe("handled");
    expect(repl.prompt()).toBe("bsky ›");
    await repl.startThread("one");
    await flush();
    expect(repl.interrupt("")).toBe("handled");
    expect(repl.mode().kind).toBe("idle");
  });
  it("says what would be lost on exit", async () => {
    const { repl } = setup({ undo: 5 });
    expect(repl.wouldLose("")).toBe(false);
    expect(repl.wouldLose("draft")).toBe(true);
    await repl.post("waiting");
    expect(repl.wouldLose("")).toBe(true);
  });
});

describe("closing", () => {
  it("cancels what's queued and refuses new posts", async () => {
    const { repl, agent, flush } = setup({ undo: 5 });
    await repl.post("waiting");
    expect(repl.close().map((i) => i.posts)).toEqual([["waiting"]]);
    expect(await repl.post("after")).toBe("keep");
    await vi.advanceTimersByTimeAsync(20_000);
    await flush();
    expect(agent.post).not.toHaveBeenCalled();
  });
});

describe("failures", () => {
  it("saves a network failure as a draft and resends it on /retry", async () => {
    const { repl, agent, posted, flush, printed } = setup();
    agent.post.mockRejectedValueOnce(new Error("fetch failed"));
    await repl.post("hello");
    await flush();
    expect(printed()).toContain("Couldn't reach Bluesky; saved as draft d1. /retry to send it now.");
    await repl.retry();
    await flush();
    expect(posted.map((p) => p.text)).toEqual(["hello"]);
    expect(repl.failures()).toHaveLength(1);
  });
  it("says when the session has expired", async () => {
    const { repl, agent, flush, printed } = setup();
    agent.post.mockRejectedValueOnce(Object.assign(new Error("expired"), { status: 401 }));
    await repl.post("hello");
    await flush();
    expect(printed()).toContain("Session expired — exit and run `bsky login`");
  });
});
