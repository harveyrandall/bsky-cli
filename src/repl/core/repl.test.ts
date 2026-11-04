import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Repl, IDLE_HINT, type ReplAsk, type ReplSettings } from "./repl";
import { DEFAULT_MARKERS } from "./markers";
import type { AtUri, Cid, Did, StrongRef } from "./types";
import type { SendTarget } from "./pipeline";
import type { LineStyle } from "./commands";
import type { MediaFs, StagedMedia } from "./media";

const me = "did:plc:me" as Did;
const ref = (n: number): StrongRef => ({
  uri: `at://${me}/app.bsky.feed.post/3lbx7kt5def${String.fromCharCode(97 + n)}a` as AtUri,
  cid: `bafy${n}` as Cid,
});

const rejected = () => Object.assign(new Error("Invalid record"), { status: 400 });
const fs: MediaFs = {
  size: async (path) => (path.includes("missing") ? undefined : 10),
  head: async (path) => new Uint8Array(path.endsWith(".mp4") ? [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70] : [0x89, 0x50, 0x4e, 0x47]),
};

function setup(settings: Partial<ReplSettings> = {}, answers: Partial<ReplAsk> = {}) {
  let n = 0;
  const posted: { text: string; reply?: SendTarget; media?: readonly StagedMedia[]; quote?: StrongRef }[] = [];
  const agent = {
    selfDid: me,
    resolveHandle: vi.fn(async () => me),
    getPosts: vi.fn(async () => []),
    post: vi.fn(async (text: string, reply?: SendTarget, media?: readonly StagedMedia[], quote?: StrongRef) => {
      posted.push({ text, reply, media, quote });
      return ref(++n);
    }),
  };
  const ask: ReplAsk = {
    cooldown: vi.fn(async () => 0 as const),
    saveOffer: vi.fn(async () => "no" as const),
    confirm: vi.fn(async () => true),
    alt: vi.fn(async () => undefined),
    choose: vi.fn(async () => undefined),
    text: vi.fn(async () => undefined),
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
    saveScheduled: vi.fn(async () => ({ id: "s1" })),
    composerBusy: vi.fn(() => false),
    schedulerRunning: vi.fn(() => true),
    fs,
  };
  const repl = new Repl(
    { autoThread: false, prefixThread: false, threadLabel: false, undo: 0, pace: 0, askToSave: true, verbose: false, forceAlt: false, ...settings },
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
  it("without its label, along with the posts after it, when part of a thread batch is rejected", async () => {
    const { repl, agent, deps, flush } = setup({ threadLabel: "append" });
    agent.post.mockResolvedValueOnce(ref(1)).mockRejectedValueOnce(rejected());
    await repl.startThread();
    await repl.submitText("one /// bad /// three");
    await flush();
    expect(deps.restore).toHaveBeenCalledWith("bad /// three");
  });
  it("joined with the split marker when several thread posts are cancelled", async () => {
    const { repl } = setup({ undo: 5 });
    await repl.startThread();
    await repl.submitText("a");
    await repl.submitText("b");
    expect(repl.escape("")).toEqual({ restore: "a /// b" });
  });
  it("as drafts when cancelled items are going to different places", async () => {
    const { repl, deps, flush } = setup({ undo: 5 });
    await repl.post("a");
    await repl.post("b");
    expect(repl.escape("")).toBe("handled");
    await flush();
    expect(deps.saveDraft).toHaveBeenCalledTimes(2);
  });
  it("as drafts when one of several cancelled items has media, which would move to the first post", async () => {
    const { repl, deps, flush } = setup({ undo: 5 });
    await repl.startThread();
    await repl.submitText("a");
    await repl.attach(["/x/a.png"]);
    await repl.submitText("b");
    expect(repl.escape("")).toBe("handled");
    await flush();
    expect(deps.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ text: "b", images: ["/x/a.png"] }));
    expect(repl.staged()).toEqual([]);
  });
  it("as what you typed when pending posts are cancelled with an empty composer", async () => {
    const { repl } = setup({ undo: 5 });
    await repl.post("waiting");
    expect(repl.escape("")).toEqual({ restore: "/post waiting" });
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

describe("drafts of what's queued", () => {
  it("keep each item's shape and leave the thread label out", async () => {
    const { repl, flush } = setup({ threadLabel: "append" });
    await repl.post("first");
    await flush();
    repl.setCooldown("undo", 5);
    await repl.startThread();
    await repl.submitText("one /// two");
    await repl.reply("1", "hi");
    await repl.post("solo");
    expect(repl.draftItems()).toEqual([
      { reason: "manual", type: "thread", text: "one", posts: [{ text: "one" }, { text: "two" }] },
      { reason: "manual", type: "reply", text: "hi", replyUri: ref(1).uri },
      { reason: "manual", type: "post", text: "solo" },
    ]);
  });
  it("reply to the last post sent when part of a batch has gone", async () => {
    const { repl, flush } = setup({ pace: 5 });
    await repl.post("one /// two");
    await flush();
    expect(repl.draftItems()).toEqual([{ reason: "manual", type: "reply", text: "two", replyUri: ref(1).uri }]);
  });
  it("leave out a post already on its way, which can't be stopped", async () => {
    const { repl, agent, flush } = setup();
    agent.post.mockImplementationOnce(() => new Promise(() => {}));
    await repl.post("one /// two");
    await flush();
    expect(repl.pendingCount()).toBe(1);
    expect(repl.draftItems()).toEqual([{ reason: "manual", type: "post", text: "two" }]);
  });
  it("are saved one per item when Esc can't put them back in the composer", async () => {
    const { repl, deps, flush } = setup({ undo: 5 });
    await repl.post("a");
    await repl.post("b");
    expect(repl.escape("typing")).toBe("handled");
    await flush();
    expect(deps.saveDraft).toHaveBeenCalledTimes(2);
    expect(deps.saveDraft).toHaveBeenNthCalledWith(1, expect.objectContaining({ text: "a" }));
    expect(deps.saveDraft).toHaveBeenNthCalledWith(2, expect.objectContaining({ text: "b" }));
  });
});

describe("cancelling a retry", () => {
  it("deletes its old draft, which still holds the posts already sent", async () => {
    const { repl, agent, deps, flush, printed } = setup({ pace: 5 });
    agent.post.mockRejectedValueOnce(new Error("fetch failed"));
    await repl.post("one /// two");
    await flush();
    await repl.retry();
    await flush();
    expect(repl.escape("")).toEqual({ restore: "/reply 1 two" });
    await flush();
    expect(deps.deleteDraft).toHaveBeenCalledExactlyOnceWith("d1");
    expect(printed()).not.toContain("Left in draft");
  });
  it("warns if that draft can't be deleted", async () => {
    const { repl, agent, deps, flush, printed } = setup({ pace: 5 });
    agent.post.mockRejectedValueOnce(new Error("fetch failed"));
    deps.deleteDraft.mockRejectedValueOnce(new Error("ENOENT"));
    await repl.post("one /// two");
    await flush();
    await repl.retry();
    await flush();
    repl.escape("");
    await flush();
    expect(printed()).toContain("Couldn't delete draft d1");
  });
});

describe("draft saves that fail", () => {
  it("print the cancelled text instead of crashing", async () => {
    const { repl, deps, flush, printed } = setup({ undo: 5 });
    deps.saveDraft.mockRejectedValueOnce(new Error("EACCES"));
    await repl.post("waiting");
    expect(repl.escape("new text")).toBe("handled");
    await flush();
    expect(printed()).toContain("Couldn't save these posts as a draft (EACCES):");
    expect(printed()).toContain("waiting");
  });
});

describe("submit", () => {
  it("previews anything that isn't one plain post", async () => {
    const { repl, ask, flush, posted } = setup();
    await repl.startThread();
    await repl.submitText("a /// b //> later");
    expect(ask.confirm).toHaveBeenCalledWith(expect.objectContaining({ posts: ["a", "b"], keep: "later" }), false, []);
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

describe("media", () => {
  it("is stored by absolute path, so drafts and scheduled posts work from anywhere", async () => {
    const { repl } = setup();
    await repl.attach(["chart.png", "./sub/b.png", "/x/c.png"]);
    expect(repl.staged().map((m) => m.path)).toEqual([resolve("chart.png"), resolve("sub/b.png"), "/x/c.png"]);
  });
  const INTRO = "Alt text tells people using screen readers what's in your image — without it, they're left out of the post.";
  it("asks for alt text per file, explaining why once", async () => {
    const alt = vi.fn(async (file: string) => `about ${file}`);
    const { repl, lines } = setup({}, { alt });
    await repl.attach(["/x/a.png", "/x/b.png"]);
    expect(alt.mock.calls).toEqual([["a.png", false], ["b.png", false]]);
    expect(lines.filter(([t]) => t === INTRO)).toHaveLength(1);
    expect(repl.staged()).toEqual([
      { path: "/x/a.png", kind: "image", alt: "about a.png" },
      { path: "/x/b.png", kind: "image", alt: "about b.png" },
    ]);
  });
  it("skips alt text on a blank answer", async () => {
    const { repl } = setup({}, { alt: vi.fn(async () => "  ") });
    await repl.attach(["/x/a.png"]);
    expect(repl.staged()).toEqual([{ path: "/x/a.png", kind: "image" }]);
  });
  it("uses --alt for every file without asking", async () => {
    const { repl, ask } = setup();
    await repl.attach(["/x/a.png", "/x/b.png"], "Two charts");
    expect(ask.alt).not.toHaveBeenCalled();
    expect(repl.staged().map((m) => m.alt)).toEqual(["Two charts", "Two charts"]);
  });
  it("asks again on a blank answer with --force-alt", async () => {
    const answers = ["", "  ", "A chart"];
    const alt = vi.fn(async () => answers.shift());
    const { repl } = setup({ forceAlt: true }, { alt });
    await repl.attach(["/x/a.png"]);
    expect(alt).toHaveBeenCalledTimes(3);
    expect(alt).toHaveBeenCalledWith("a.png", true);
    expect(repl.staged()[0].alt).toBe("A chart");
  });
  it("drops just that file on Esc, and says so", async () => {
    const answers = [null, "B"];
    const { repl, printed } = setup({ forceAlt: true }, { alt: vi.fn(async () => answers.shift()) });
    await repl.attach(["/x/a.png", "/x/b.png"]);
    expect(repl.staged().map((m) => m.path)).toEqual(["/x/b.png"]);
    expect(printed()).toContain("Left out a.png");
  });
  it("says why a file can't be attached and carries on", async () => {
    const { repl, printed } = setup();
    await repl.attach(["/x/missing.png", "/x/b.png", "/x/c.mp4"]);
    expect(printed()).toContain("missing.png not found");
    expect(printed()).toContain("A post can have images or one video, not both");
    expect(repl.staged().map((m) => m.path)).toEqual(["/x/b.png"]);
  });
  it("goes on the first post of the next batch only", async () => {
    const { repl, posted, flush } = setup();
    await repl.attach(["/x/a.png"]);
    await repl.startThread();
    await repl.submitText("one /// two");
    expect(repl.staged()).toEqual([]);
    await flush();
    await repl.submitText("three");
    await flush();
    expect(posted.map((p) => p.media?.length)).toEqual([1, undefined, undefined]);
  });
  it("shows in the preview", async () => {
    const { repl, ask } = setup();
    await repl.attach(["/x/a.png"]);
    await repl.post("one /// two");
    expect(ask.confirm).toHaveBeenCalledWith(expect.anything(), false, [{ path: "/x/a.png", kind: "image" }]);
  });
  it("stays staged when the preview is declined", async () => {
    const { repl } = setup({}, { confirm: vi.fn(async () => false) });
    await repl.attach(["/x/a.png"]);
    await repl.post("one /// two");
    expect(repl.staged()).toHaveLength(1);
  });
  it("returns media with the text when the server rejects the post", async () => {
    const { repl, agent, deps, flush } = setup();
    agent.post.mockRejectedValueOnce(rejected());
    await repl.attach(["/x/a.png"]);
    await repl.post("bad");
    await flush();
    expect(deps.restore).toHaveBeenCalledWith("/post bad");
    expect(repl.staged().map((m) => m.path)).toEqual(["/x/a.png"]);
  });
  it("doesn't return media already sent when a later post is rejected", async () => {
    const { repl, agent, flush } = setup();
    agent.post.mockResolvedValueOnce(ref(1)).mockRejectedValueOnce(rejected());
    await repl.attach(["/x/a.png"]);
    await repl.post("one /// bad");
    await flush();
    expect(repl.staged()).toEqual([]);
  });
  it("keeps media in the draft on a network failure", async () => {
    const { repl, agent, deps, flush } = setup();
    agent.post.mockRejectedValueOnce(new Error("fetch failed"));
    await repl.attach(["/x/a.png"]);
    await repl.post("hello");
    await flush();
    expect(deps.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ images: ["/x/a.png"], imageAlts: ["a.png"] }));
    expect(repl.staged()).toEqual([]);
  });
  it("comes back when a queued post is cancelled", async () => {
    const { repl } = setup({ undo: 5 });
    await repl.attach(["/x/a.png"]);
    await repl.post("waiting");
    expect(repl.staged()).toEqual([]);
    repl.escape("");
    expect(repl.staged()).toHaveLength(1);
  });
  it("goes into the draft when a cancelled post can't return to the composer", async () => {
    const { repl, deps, flush } = setup({ undo: 5 });
    await repl.attach(["/x/a.png"]);
    await repl.post("waiting");
    repl.escape("typing");
    await flush();
    expect(deps.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ images: ["/x/a.png"] }));
    expect(repl.staged()).toEqual([]);
  });
  it("goes to a draft with its text if it can't join what's been staged since", async () => {
    const { repl, deps, flush } = setup({ undo: 5 });
    await repl.attach(["/x/a.png"]);
    await repl.post("waiting");
    await repl.attach(["/x/b.mp4"]);
    expect(repl.escape("")).toBe("handled");
    await flush();
    expect(repl.staged().map((m) => m.path)).toEqual(["/x/b.mp4"]);
    expect(deps.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ text: "waiting", images: ["/x/a.png"] }));
  });
  it("goes back to being staged if its draft can't be saved", async () => {
    const { repl, deps, flush, printed } = setup({ undo: 5 });
    deps.saveDraft.mockRejectedValueOnce(new Error("EACCES"));
    await repl.attach(["/x/a.png"]);
    await repl.post("waiting");
    repl.escape("typing");
    await flush();
    expect(printed()).toContain("waiting");
    expect(repl.staged().map((m) => m.path)).toEqual(["/x/a.png"]);
  });
  it("goes to a draft with a rejected post if it can't join what's been staged since", async () => {
    const { repl, agent, deps, flush } = setup({ undo: 5 });
    agent.post.mockRejectedValueOnce(rejected());
    await repl.attach(["/x/a.png"]);
    await repl.post("bad");
    await repl.attach(["/x/b.mp4"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(deps.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ text: "bad", images: ["/x/a.png"] }));
    expect(deps.restore).not.toHaveBeenCalled();
  });
  it("checks the limits again after the alt prompt, in case something came back meanwhile", async () => {
    const s = setup({ undo: 5 });
    await s.repl.attach(["/x/clip.mp4"]);
    await s.repl.post("waiting");
    s.ask.alt = vi.fn(async () => {
      s.repl.escape("");
      return undefined;
    });
    await s.repl.attach(["/x/a.png"]);
    expect(s.repl.staged().map((m) => m.path)).toEqual(["/x/clip.mp4"]);
    expect(s.printed()).toContain("A post can have images or one video, not both");
  });
  it("keeps what's staged while a draft saves, if it wasn't part of the draft", async () => {
    const choose = vi.fn(async (_: string, options: readonly string[]) => options.indexOf("Draft"));
    const s = setup({}, { choose });
    await s.repl.newMenu();
    await s.repl.attach(["/x/a.png"]);
    s.deps.saveDraft.mockImplementationOnce(async () => {
      await s.repl.attach(["/x/b.png"]);
      return { id: "d1" };
    });
    await s.repl.submitText("later");
    expect(s.repl.staged().map((m) => m.path)).toEqual(["/x/b.png"]);
  });
  it("detaches one file or all of them", async () => {
    const { repl, printed } = setup();
    await repl.attach(["/x/a.png", "/x/b.png", "/x/c.png"]);
    repl.detach(2);
    expect(repl.staged().map((m) => m.path)).toEqual(["/x/a.png", "/x/c.png"]);
    repl.detach(9);
    expect(printed()).toContain("No attachment 9");
    repl.detach("all");
    expect(repl.staged()).toEqual([]);
  });
  it("counts as something to lose on exit, and can be saved as a draft", async () => {
    const { repl } = setup();
    await repl.attach(["/x/a.png"]);
    expect(repl.wouldLose("")).toBe(true);
    expect(repl.composerDrafts("")).toMatchObject([{ reason: "manual", type: "post", text: "", images: ["/x/a.png"] }]);
    expect(repl.composerDrafts("hi")).toMatchObject([{ text: "hi", images: ["/x/a.png"] }]);
  });
  it("leaves nothing to save when there's no text or media", () => {
    const { repl } = setup();
    expect(repl.composerDrafts("  ")).toEqual([]);
  });
});

describe("a post coming back while you're typing", () => {
  it("goes to a draft with its media, rather than leaving the media for your next post", async () => {
    const { repl, agent, deps, flush, printed } = setup();
    deps.composerBusy.mockReturnValue(true);
    agent.post.mockRejectedValueOnce(rejected());
    await repl.attach(["/x/a.png"]);
    await repl.post("hello");
    await flush();
    expect(deps.saveDraft).toHaveBeenCalledWith({ reason: "manual", type: "post", text: "hello", images: ["/x/a.png"], imageAlts: ["a.png"] });
    expect(printed()).toContain("A post came back while you were typing; saved it as draft d1");
    expect(repl.staged()).toEqual([]);
    expect(deps.restore).not.toHaveBeenCalled();
  });
  it("keeps a reply's parent and a quote's target", async () => {
    const { repl, agent, deps, flush } = setup();
    await repl.post("first");
    await flush();
    deps.composerBusy.mockReturnValue(true);
    agent.post.mockRejectedValueOnce(rejected()).mockRejectedValueOnce(rejected());
    await repl.reply("1", "a reply");
    await flush();
    await repl.quote("1", "a quote");
    await flush();
    expect(deps.saveDraft).toHaveBeenCalledWith({ reason: "manual", type: "reply", text: "a reply", replyUri: ref(1).uri });
    expect(deps.saveDraft).toHaveBeenCalledWith({ reason: "manual", type: "quote", text: "a quote", quoteUri: ref(1).uri });
  });
});

describe("saving the composer as a draft", () => {
  const withPost = async (settings: Partial<ReplSettings> = {}) => {
    const s = setup(settings);
    await s.repl.post("first");
    await s.flush();
    return s;
  };
  it("keeps the post a once mode was writing to", async () => {
    const { repl } = await withPost();
    await repl.reply("1");
    expect(repl.composerDrafts("hi")).toEqual([{ reason: "manual", type: "reply", text: "hi", replyUri: ref(1).uri }]);
    repl.escape("");
    await repl.quote("1");
    expect(repl.composerDrafts("hi")).toEqual([{ reason: "manual", type: "quote", text: "hi", quoteUri: ref(1).uri }]);
  });
  it("keeps the thread it was continuing", async () => {
    const { repl, flush } = setup();
    await repl.startThread("one");
    await flush();
    expect(repl.composerDrafts("two")).toEqual([{ reason: "manual", type: "reply", text: "two", replyUri: ref(1).uri }]);
  });
  it("splits on markers and keeps text marked for later", () => {
    const { repl } = setup();
    expect(repl.composerDrafts("a /// b //> c")).toMatchObject([{ type: "thread", posts: [{ text: "a" }, { text: "b" }, { text: "c" }] }]);
  });
  it("reads a command that came back to the composer", async () => {
    const { repl } = await withPost();
    expect(repl.composerDrafts("/post hi")).toEqual([{ reason: "manual", type: "post", text: "hi" }]);
    expect(repl.composerDrafts("/thread hi")).toEqual([{ reason: "manual", type: "post", text: "hi" }]);
    expect(repl.composerDrafts("/reply 1 hi")).toEqual([{ reason: "manual", type: "reply", text: "hi", replyUri: ref(1).uri }]);
    expect(repl.composerDrafts("/quote 1 hi")).toEqual([{ reason: "manual", type: "quote", text: "hi", quoteUri: ref(1).uri }]);
  });
  it("keeps the text as it is if a command's post isn't known", () => {
    const { repl } = setup();
    expect(repl.composerDrafts("/reply 9 hi")).toEqual([{ reason: "manual", type: "post", text: "/reply 9 hi" }]);
  });
  it("keeps media apart from a quote, which can't carry it", async () => {
    const { repl } = await withPost();
    await repl.attach(["/x/a.png"]);
    expect(repl.composerDrafts("/quote 1 hi")).toEqual([
      { reason: "manual", type: "quote", text: "hi", quoteUri: ref(1).uri },
      { reason: "manual", type: "post", text: "", images: ["/x/a.png"], imageAlts: ["a.png"] },
    ]);
  });
});

describe("printed posts", () => {
  it("say how many images went with them", async () => {
    const { repl, flush, printed } = setup();
    await repl.attach(["/x/a.png", "/x/b.png"]);
    await repl.post("one /// two");
    await flush();
    expect(printed()).toMatch(/\(1\) \S+ 📷 2$/m);
    expect(printed()).toMatch(/\(2\) \S+$/m);
  });
  it("mark a video", async () => {
    const { repl, flush, printed } = setup();
    await repl.attach(["/x/a.mp4"]);
    await repl.post("one");
    await flush();
    expect(printed()).toMatch(/\(1\) \S+ 🎞$/m);
  });
  it("say what they quote", async () => {
    const { repl, flush, printed } = setup();
    await repl.post("one");
    await flush();
    await repl.quote("1", "look");
    await flush();
    expect(printed()).toMatch(/\(2\) \S+ ❝ 1$/m);
  });
});

describe("/quote", () => {
  const withPost = async (s: ReturnType<typeof setup>) => {
    await s.repl.post("first");
    await s.flush();
    return s;
  };
  it("quotes with text straight away", async () => {
    const { repl, posted, flush } = await withPost(setup());
    expect(await repl.quote("1", "look")).toBe("done");
    await flush();
    expect(posted[1]).toMatchObject({ text: "look", quote: ref(1) });
    expect(posted[1].reply).toBeUndefined();
  });
  it("leaves staged media for the next post, and says so", async () => {
    const { repl, posted, flush, printed } = await withPost(setup());
    await repl.attach(["/x/a.png"]);
    await repl.quote("1", "look");
    await flush();
    expect(posted[1].media).toBeUndefined();
    expect(repl.staged()).toHaveLength(1);
    expect(printed()).toContain("Quote posts can't have media; 📎 a.png stays for the next post");
  });
  it("waits for the text in quote-once mode, then goes back", async () => {
    const { repl, posted, flush } = await withPost(setup());
    await repl.startThread();
    expect(await repl.quote("1")).toBe("done");
    expect(repl.prompt()).toBe("quote→1 ›");
    await repl.submitText("look");
    await flush();
    expect(posted[1].quote).toEqual(ref(1));
    expect(repl.mode().kind).toBe("thread");
  });
  it("is one post", async () => {
    const { repl, ask, printed } = await withPost(setup());
    expect(await repl.quote("1", "a /// b")).toBe("keep");
    expect(ask.confirm).not.toHaveBeenCalled();
    expect(printed()).toContain("A quote is a single post");
  });
  it("comes back as /quote when rejected", async () => {
    const { repl, agent, deps, flush } = await withPost(setup());
    agent.post.mockRejectedValueOnce(rejected());
    await repl.quote("1", "bad");
    await flush();
    expect(deps.restore).toHaveBeenCalledWith("/quote 1 bad");
  });
  it("is left alone by Esc like the other once modes", async () => {
    const { repl } = await withPost(setup());
    await repl.quote("1");
    expect(repl.escape("")).toBe("handled");
    expect(repl.mode().kind).toBe("idle");
  });
});

describe("/new", () => {
  const pick = (item: string) => ({ choose: vi.fn(async (_: string, options: readonly string[]) => options.indexOf(item)) });
  it("offers every kind of post", async () => {
    const { repl, ask } = setup();
    await repl.newMenu();
    expect(ask.choose).toHaveBeenCalledWith("New:", ["Post", "Thread", "Image post", "Video post", "Quote post", "Scheduled post", "Draft"]);
  });
  it("leaves the thread alone if you dismiss it", async () => {
    const { repl, flush } = setup();
    await repl.startThread("one");
    await flush();
    await repl.newMenu();
    expect(repl.mode().kind).toBe("thread");
    expect(repl.thread()).toBeDefined();
  });
  it("clears /new from the composer if you dismiss it", async () => {
    const { repl } = setup();
    expect(await repl.newMenu()).toBe("done");
  });
  it("keeps the thread going until a sub-prompt is answered", async () => {
    const { repl, flush } = setup({}, { ...pick("Image post"), text: vi.fn(async () => undefined) });
    await repl.startThread("one");
    await flush();
    await repl.newMenu();
    expect(repl.mode().kind).toBe("thread");
    expect(repl.thread()).toBeDefined();
  });
  it("treats a blank path as dismissing the prompt", async () => {
    const { repl, printed } = setup({}, { ...pick("Image post"), text: vi.fn(async () => "  ") });
    await repl.newMenu();
    expect(printed()).not.toContain("not found");
  });
  it("stops the thread when you pick something", async () => {
    const { repl, flush, printed } = setup({}, pick("Post"));
    await repl.startThread("one");
    await flush();
    expect(await repl.newMenu()).toBe("done");
    expect(printed()).toContain("Thread stopped");
    expect(repl.mode()).toEqual({ kind: "post-once", returnTo: "idle" });
  });
  it("waits for pending posts", async () => {
    const { repl, ask } = setup({ undo: 5 });
    await repl.post("waiting");
    expect(await repl.newMenu()).toBe("keep");
    expect(ask.choose).not.toHaveBeenCalled();
  });
  it("starts a thread", async () => {
    const { repl } = setup({}, pick("Thread"));
    await repl.newMenu();
    expect(repl.mode().kind).toBe("thread");
  });
  it.each([["Image post", "/x/a b.png"], ["Video post", "/x/a b.mp4"]])("%s asks for a path, attaches it and waits for the text", async (item, path) => {
    const { repl, ask } = setup({}, { ...pick(item), text: vi.fn(async () => path) });
    await repl.newMenu();
    expect(ask.text).toHaveBeenCalledWith("Path to the file:");
    expect(repl.staged().map((m) => m.path)).toEqual([path]);
    expect(repl.prompt()).toBe("post ›");
  });
  it("stays idle if nothing could be attached", async () => {
    const { repl, printed } = setup({}, { ...pick("Image post"), text: vi.fn(async () => "/x/missing.png") });
    await repl.newMenu();
    expect(printed()).toContain("missing.png not found");
    expect(repl.mode().kind).toBe("idle");
  });
  it("asks which post to quote", async () => {
    const s = setup({}, { ...pick("Quote post"), text: vi.fn(async () => "1") });
    await s.repl.post("first");
    await s.flush();
    await s.repl.newMenu();
    expect(s.ask.text).toHaveBeenCalledWith("Post to quote (number, link or at:// URI):");
    expect(s.repl.prompt()).toBe("quote→1 ›");
  });
  it("writes a draft", async () => {
    const { repl, deps, printed } = setup({}, pick("Draft"));
    await repl.attach(["/x/a.png"]);
    await repl.newMenu();
    expect(repl.prompt()).toBe("draft ›");
    expect(await repl.submitText("later")).toBe("done");
    expect(deps.saveDraft).toHaveBeenCalledWith({ reason: "manual", type: "post", text: "later", images: ["/x/a.png"], imageAlts: ["a.png"] });
    expect(printed()).toContain("Saved as draft d1");
    expect(repl.staged()).toEqual([]);
    expect(repl.mode().kind).toBe("idle");
  });
  it("refuses a post over the limit, which would half-send later", async () => {
    const { repl, deps, printed } = setup({}, pick("Draft"));
    await repl.newMenu();
    expect(await repl.submitText(`short /// ${"y".repeat(301)}`)).toBe("keep");
    expect(printed()).toContain("Post 2 is 301/300");
    expect(deps.saveDraft).not.toHaveBeenCalled();
    expect(repl.mode().kind).toBe("draft-once");
  });
  it("says what it cut from a draft", async () => {
    const { repl, printed } = setup({}, pick("Draft"));
    await repl.newMenu();
    await repl.submitText("keep this <// scrap");
    expect(printed()).toContain("Discarded: scrap");
  });
  it("keeps a thread's shape in a draft", async () => {
    const { repl, deps } = setup({}, pick("Draft"));
    await repl.newMenu();
    await repl.submitText("a /// b");
    expect(deps.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ type: "thread", posts: [{ text: "a" }, { text: "b" }] }));
  });
});

describe("scheduled posts", () => {
  const when = new Date(2026, 10, 5, 15, 30).toISOString();
  const answers = (...texts: (string | undefined)[]) => ({
    choose: vi.fn(async (label: string, options: readonly string[]) => (label === "New:" ? options.indexOf("Scheduled post") : 1)),
    text: vi.fn(async () => texts.shift()),
  });
  it("save the text and media for the time you give", async () => {
    const { repl, deps, printed } = setup({}, answers("05-11-2026", "15:30"));
    await repl.attach(["/x/a.png"]);
    await repl.newMenu();
    expect(repl.prompt()).toBe("scheduled ›");
    expect(await repl.submitText("later")).toBe("done");
    expect(deps.saveScheduled).toHaveBeenCalledWith({ scheduledAt: when, text: "later", images: ["/x/a.png"], imageAlts: ["a.png"] });
    expect(printed()).toContain("Scheduled for 5 Nov 2026, 15:30 (s1)");
    expect(repl.staged()).toEqual([]);
    expect(repl.mode().kind).toBe("idle");
  });
  it("say so when nothing will send them", async () => {
    const { repl, deps, printed } = setup({}, answers("05-11-2026", "15:30"));
    deps.schedulerRunning.mockReturnValue(false);
    await repl.newMenu();
    await repl.submitText("later");
    expect(printed()).toContain("Nothing sends it until the scheduler runs: `bsky schedule enable`, or `bsky schedule watch` in another terminal");
  });
  it("don't mention the scheduler when it's running", async () => {
    const { repl, printed } = setup({}, answers("05-11-2026", "15:30"));
    await repl.newMenu();
    await repl.submitText("later");
    expect(printed()).not.toContain("scheduler");
  });
  it("ask AM or PM when the hour could be either", async () => {
    const { repl, deps, ask } = setup({}, answers("05-11-2026", "3:30"));
    await repl.newMenu();
    await repl.submitText("later");
    expect(ask.choose).toHaveBeenCalledWith("AM or PM?", ["AM", "PM"]);
    expect(deps.saveScheduled).toHaveBeenCalledWith(expect.objectContaining({ scheduledAt: when }));
  });
  it("ask again after a bad date, a bad time or a time in the past", async () => {
    const { repl, deps, printed } = setup({}, answers("nonsense", "05-11-2026", "25:00", "01-01-2026", "15:30", "05-11-2026", "15:30"));
    await repl.newMenu();
    await repl.submitText("later");
    expect(printed()).toContain("Invalid date. Use DD-MM or DD-MM-YYYY format");
    expect(printed()).toContain("Invalid time. Use HH:MM format");
    expect(printed()).toContain("Date must be in the future.");
    expect(deps.saveScheduled).toHaveBeenCalledOnce();
  });
  it("keep the text and the mode if you back out", async () => {
    const { repl, deps } = setup({}, answers(undefined));
    await repl.newMenu();
    expect(await repl.submitText("later")).toBe("keep");
    expect(deps.saveScheduled).not.toHaveBeenCalled();
    expect(repl.mode().kind).toBe("schedule-once");
  });
  it("refuse a post over the limit, even one a marker kept from splitting", async () => {
    const { repl, deps, printed } = setup({}, answers("05-11-2026", "15:30"));
    await repl.newMenu();
    expect(await repl.submitText(`${"y".repeat(301)} ///`)).toBe("keep");
    expect(printed()).toContain("Post 1 is 301/300");
    expect(deps.saveScheduled).not.toHaveBeenCalled();
  });
  it("say what was cut", async () => {
    const { repl, printed } = setup({}, answers("05-11-2026", "15:30"));
    await repl.newMenu();
    await repl.submitText("keep this <// scrap");
    expect(printed()).toContain("Discarded: scrap");
  });
  it("are one post", async () => {
    const { repl, deps, printed } = setup({}, answers("05-11-2026", "15:30"));
    await repl.newMenu();
    expect(await repl.submitText("a /// b")).toBe("keep");
    expect(printed()).toContain("A scheduled post is a single post");
    expect(deps.saveScheduled).not.toHaveBeenCalled();
  });
});

describe("refs and labels", () => {
  it("keeps escaped markers escaped when a post comes back", async () => {
    const { repl, agent, deps, flush } = setup();
    agent.post.mockRejectedValueOnce(rejected());
    await repl.post("a \\/// b");
    await flush();
    expect(deps.restore).toHaveBeenCalledWith("/post a \\/// b");
  });
  it("keeps escaped markers escaped in text kept for later", async () => {
    const { repl } = setup();
    await repl.startThread();
    expect(await repl.submitText("a //> b \\/// c")).toEqual({ restore: "b \\/// c" });
  });
  it("reads a bare number as the last thread's, even after a post on its own", async () => {
    const { repl, flush } = setup({ prefixThread: true });
    await repl.startThread("one");
    await flush();
    await repl.submitText("two");
    await flush();
    repl.escape("");
    await repl.post("solo");
    await flush();
    await repl.reply("2");
    expect(repl.prompt()).toBe("reply→A2 ›");
  });
  it("posts a long word as text rather than reading it as a record key", async () => {
    const { repl, agent, posted, flush } = setup();
    expect(await repl.startThread("unfortunately")).toBe("done");
    await flush();
    expect(posted.map((p) => p.text)).toEqual(["unfortunately"]);
    expect(agent.getPosts).not.toHaveBeenCalled();
  });
  it("still reads a record key as a ref", async () => {
    const { repl, agent } = setup();
    expect(await repl.startThread("3lbx7kt5defza")).toBe("keep");
    expect(agent.getPosts).toHaveBeenCalledOnce();
  });
  it("keeps /reply-from in the composer when it can't go ahead", async () => {
    const { repl, flush } = setup();
    expect(await repl.replyFrom("9")).toBe("keep");
    await repl.post("first");
    await flush();
    expect(await repl.replyFrom("1")).toBe("done");
  });
  it("says the thread stopped when /thread is used from a once mode on top of it", async () => {
    const { repl, flush, printed } = setup();
    await repl.startThread("one");
    await flush();
    await repl.post();
    await repl.startThread();
    expect(printed()).toContain("Thread stopped");
  });
  it("shows a waiting post without its label, even when the label goes first", async () => {
    const { repl } = setup({ undo: 5, threadLabel: "prepend" });
    await repl.startThread("one");
    expect(repl.waiting()).toBe("one");
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
  it("saves only what it asked about", async () => {
    const { repl, deps } = setup({ undo: 5, pace: undefined }, { saveOffer: vi.fn(async () => "yes" as const) });
    await repl.startThread();
    expect(deps.saveConfig).toHaveBeenCalledExactlyOnceWith({ pace: 0 });
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
  it("block /thread, which would move the cursor", async () => {
    const { repl, printed } = setup({ undo: 5 });
    await repl.post("one");
    expect(await repl.startThread()).toBe("keep");
    expect(printed()).toContain("Wait for pending posts, or Esc to cancel them");
  });
  it("block /reply-from too", async () => {
    const { repl, printed } = setup({ undo: 5 });
    await repl.post("one");
    expect(await repl.replyFrom("1")).toBe("keep");
    expect(printed()).toContain("Wait for pending posts, or Esc to cancel them");
  });
  it("chain in order when typed faster than the pace allows", async () => {
    const { repl, posted } = setup({ pace: 10 });
    await repl.startThread();
    for (const text of ["a", "b", "c"]) await repl.submitText(text);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(posted.map((p) => [p.text, p.reply?.parent.uri, p.reply?.root.uri])).toEqual([
      ["a", undefined, undefined],
      ["b", ref(1).uri, ref(1).uri],
      ["c", ref(2).uri, ref(1).uri],
    ]);
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
    expect(repl.failures()).toEqual([]);
  });
  it("records only the latest failure of a retried post", async () => {
    const { repl, agent, flush } = setup();
    agent.post.mockRejectedValueOnce(new Error("fetch failed")).mockRejectedValueOnce(new Error("fetch failed"));
    await repl.post("hello");
    await flush();
    await repl.retry();
    await flush();
    expect(repl.failures()).toHaveLength(1);
  });
  it("won't retry while a draft is still being saved", async () => {
    const { repl, agent, deps, flush, printed } = setup();
    let saved = (_: { id: string }) => {};
    deps.saveDraft.mockImplementationOnce(() => new Promise((resolve) => (saved = resolve)));
    agent.post.mockRejectedValueOnce(new Error("fetch failed"));
    await repl.post("hello");
    await flush();
    await repl.retry();
    expect(printed()).toContain("Nothing to retry");
    saved({ id: "d1" });
    await flush();
    await repl.retry();
    await flush();
    expect(agent.post).toHaveBeenCalledTimes(2);
  });
  it("says which post of a batch the server rejected", async () => {
    const { repl, agent, flush, printed } = setup();
    agent.post.mockResolvedValueOnce(ref(1)).mockRejectedValueOnce(rejected());
    await repl.post("one /// two /// three");
    await flush();
    expect(printed()).toContain("Post 2 of 3 wasn't sent: Invalid record");
  });
  it("gives a lone rejected post just the server's reason", async () => {
    const { repl, agent, flush, lines } = setup();
    agent.post.mockRejectedValueOnce(rejected());
    await repl.post("bad");
    await flush();
    expect(lines).toContainEqual(["Invalid record", "error"]);
  });
  it("tells a rate limit from an outage", async () => {
    const { repl, agent, flush, printed } = setup();
    agent.post.mockRejectedValueOnce(Object.assign(new Error("Rate Limit Exceeded"), { status: 429 }));
    await repl.post("hello");
    await flush();
    expect(printed()).toContain("Rate limited; saved as draft d1. /retry to send it later.");
  });
  it("says what it was looking up when a ref can't be fetched", async () => {
    const { repl, agent, printed } = setup();
    agent.getPosts.mockRejectedValueOnce(new Error("fetch failed"));
    await repl.reply("3lbx7kt5defza");
    expect(printed()).toContain('Couldn\'t look up "3lbx7kt5defza": fetch failed');
  });
  it("says when the session has expired", async () => {
    const { repl, agent, flush, printed } = setup();
    agent.post.mockRejectedValueOnce(Object.assign(new Error("expired"), { status: 401 }));
    await repl.post("hello");
    await flush();
    expect(printed()).toContain("Session expired — exit and run `bsky login`");
  });
});
