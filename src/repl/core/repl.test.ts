import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Repl, IDLE_HINT, type ReplAsk, type ReplSettings } from "./repl";
import { DEFAULT_MARKERS } from "./markers";
import { parseSessionFile } from "./persist";
import type { AtUri, Cid, Did, StrongRef } from "./types";
import type { SendTarget } from "./pipeline";
import type { Draft } from "@/lib/types";
import type { LineStyle } from "./commands";
import type { MediaFs, StagedMedia } from "./media";

const me = "did:plc:me" as Did;
const letter = (n: number) => String.fromCharCode(97 + n);
const ref = (n: number): StrongRef => ({
  uri: `at://${me}/app.bsky.feed.post/3lbx7kt5def${letter(n % 26)}${letter(Math.floor(n / 26))}` as AtUri,
  cid: `bafy${letter(n % 26)}${n < 26 ? "" : letter(Math.floor(n / 26))}` as Cid,
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
    like: vi.fn(async (_: StrongRef) => {}),
    unlike: vi.fn(async (_: StrongRef) => true),
    repost: vi.fn(async (_: StrongRef) => {}),
    unrepost: vi.fn(async (_: StrongRef) => true),
    deletePost: vi.fn(async (_: string) => {}),
  };
  const ask: ReplAsk = {
    cooldown: vi.fn(async () => 0 as const),
    saveOffer: vi.fn(async () => "no" as const),
    confirm: vi.fn(async () => true),
    alt: vi.fn(async () => undefined),
    choose: vi.fn(async () => undefined),
    text: vi.fn(async () => undefined),
    yesNo: vi.fn(async () => true),
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
    openUrl: vi.fn(async () => {}),
    copyText: vi.fn(async () => {}),
    listDrafts: vi.fn(async (): Promise<Draft[]> => []),
    switchAccount: vi.fn(async (_: string) => ({ agent, handle: "work.bsky.social" })),
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
    expect(repl.escape("")).toBe("handled");
    await flush();
    expect(deps.saveDraft).toHaveBeenLastCalledWith({ reason: "manual", type: "reply", text: "two", replyUri: ref(1).uri });
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
  it("expands ~/ in a path", async () => {
    const { repl } = setup();
    await repl.attach(["~/a.png"]);
    expect(repl.staged().map((m) => m.path)).toEqual([join(homedir(), "a.png")]);
  });
  it("doesn't let a blank --alt get round --force-alt", async () => {
    const { repl, ask } = setup({ forceAlt: true }, { alt: vi.fn(async () => "A chart") });
    await repl.attach(["/x/a.png"], "   ");
    expect(ask.alt).toHaveBeenCalledOnce();
    expect(repl.staged()[0].alt).toBe("A chart");
  });
  it("leaves a file out on Esc even when alt text is optional", async () => {
    const { repl, printed } = setup({}, { alt: vi.fn(async () => null) });
    await repl.attach(["/x/a.png"]);
    expect(repl.staged()).toEqual([]);
    expect(printed()).toContain("Left out a.png");
  });
  it("calls paths media only if all of them are", async () => {
    const { repl } = setup();
    await expect(repl.areMedia(["/x/a.png", "/x/b.mp4"])).resolves.toBe(true);
    await expect(repl.areMedia(["/x/a.png", "/x/missing.png"])).resolves.toBe(false);
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

describe("resume", () => {
  const meta = { id: "k3f7xq", createdAt: "2026-11-04T09:00:00.000Z", handle: "me.bsky.social", did: me } as never;
  /** A session that wrote `posts`, as it would come back from disk. */
  const saved = async (o: { posts?: string[]; settings?: Partial<ReplSettings>; then?: (s: ReturnType<typeof setup>) => Promise<void> } = {}) => {
    const s = setup(o.settings);
    await s.repl.startThread();
    for (const text of o.posts ?? ["one", "two"]) {
      await s.repl.submitText(text);
      await s.flush();
    }
    await o.then?.(s);
    return parseSessionFile(JSON.parse(JSON.stringify(s.repl.snapshot(meta, { text: "", cursor: 0 }, []))));
  };
  const alive = (...ns: number[]) => ns.map((n) => ({ ...ref(n), authorDid: me, authorHandle: "me.bsky.social" as const, text: "" }));

  it("replays what was posted and carries the labels on", async () => {
    const file = await saved();
    const { repl, agent, flush, lines } = setup();
    agent.getPosts.mockResolvedValueOnce(alive(2, 1) as never);
    agent.post.mockResolvedValueOnce(ref(3));
    await repl.resume(file);
    expect(lines).toContainEqual(["── resumed k3f7xq ──", "dim"]);
    expect(lines.filter(([text, style]) => style === "dim" && /^\(\d\) /.test(text))).toHaveLength(2);
    await repl.submitText("three");
    await flush();
    expect(repl.registry.byLabel("3")?.uri).toBe(ref(3).uri);
  });
  it("carries on from the thread's cursor", async () => {
    const file = await saved();
    const { repl, agent, posted, flush } = setup();
    agent.getPosts.mockResolvedValueOnce(alive(2, 1) as never);
    await repl.resume(file);
    expect(repl.mode().kind).toBe("thread");
    await repl.submitText("three");
    await flush();
    expect(posted[0].reply).toEqual({ parent: ref(2), root: ref(1) });
  });
  it("falls back to the nearest post that's still there", async () => {
    const file = await saved({ posts: ["one", "two", "three"] });
    const { repl, agent, printed } = setup();
    agent.getPosts.mockResolvedValueOnce(alive(1) as never);
    await repl.resume(file);
    expect(agent.getPosts).toHaveBeenCalledWith([ref(3).uri, ref(2).uri, ref(1).uri]);
    expect(repl.thread()?.cursor).toEqual(ref(1));
    expect(printed()).toContain("Couldn't find the post you were replying to; continuing from (1)");
  });
  it("stops the thread if none of it is left", async () => {
    const file = await saved();
    const { repl, agent, printed } = setup();
    agent.getPosts.mockResolvedValueOnce([]);
    await repl.resume(file);
    expect(repl.thread()).toBeUndefined();
    expect(repl.mode().kind).toBe("idle");
    expect(printed()).toContain("Couldn't find the thread's posts; thread stopped");
  });
  it("picks the nearest post still there, not just any", async () => {
    const file = await saved({ posts: ["one", "two", "three"] });
    const { repl, agent } = setup();
    agent.getPosts.mockResolvedValueOnce(alive(1, 2) as never);
    await repl.resume(file);
    expect(repl.thread()?.cursor).toEqual(ref(2));
  });
  it("asks about 25 posts at most, as getPosts allows", async () => {
    const file = await saved({ posts: Array.from({ length: 30 }, (_, i) => `post ${i}`) });
    const { repl, agent } = setup();
    await repl.resume(file);
    expect(agent.getPosts.mock.lastCall).toMatchObject([expect.any(Array)]);
    expect((agent.getPosts.mock.lastCall as unknown as [string[]])[0]).toHaveLength(25);
  });
  it("keeps a thread with nothing sent yet, whose first post may be queued", async () => {
    const first = setup();
    await first.repl.startThread();
    const file = parseSessionFile(JSON.parse(JSON.stringify(first.repl.snapshot(meta, { text: "first", cursor: 5 }, []))));
    const { repl, printed } = setup();
    await repl.resume(file);
    expect(repl.mode().kind).toBe("thread");
    await repl.submitText("first");
    expect(printed()).not.toContain(IDLE_HINT);
  });
  it("keeps the thread if it can't check, and says so", async () => {
    const file = await saved();
    const { repl, agent, printed } = setup();
    agent.getPosts.mockRejectedValueOnce(new Error("fetch failed"));
    await repl.resume(file);
    expect(repl.thread()?.cursor).toEqual(ref(2));
    expect(printed()).toContain("Couldn't check the thread (fetch failed)");
  });
  it("drops staged files that have gone, and keeps the rest", async () => {
    const file = await saved({ then: (s) => s.repl.attach(["/x/a.png", "/x/missing.png"]).then(() => undefined) });
    file.staged.push({ path: "/x/missing.png", kind: "image" });
    const { repl, agent, printed } = setup();
    agent.getPosts.mockResolvedValueOnce(alive(2, 1) as never);
    await repl.resume(file);
    expect(repl.staged().map((m) => m.path)).toEqual(["/x/a.png"]);
    expect(printed()).toContain("Dropped /x/missing.png: missing.png not found");
  });
  it("reads a bare number as the last thread's, as it did before the kill", async () => {
    const first = setup({ prefixThread: true });
    await first.repl.startThread("one");
    await first.flush();
    first.repl.escape("");
    await first.repl.post("solo");
    await first.flush();
    const file = parseSessionFile(JSON.parse(JSON.stringify(first.repl.snapshot(meta, { text: "", cursor: 0 }, []))));
    const { repl } = setup({ prefixThread: true });
    await repl.resume(file);
    await repl.reply("1");
    expect(repl.prompt()).toBe("reply→A1 ›");
  });
  it("goes back into a once mode", async () => {
    const file = await saved({ then: (s) => s.repl.reply("1").then(() => undefined) });
    const { repl, agent } = setup();
    agent.getPosts.mockResolvedValueOnce(alive(2, 1) as never);
    await repl.resume(file);
    expect(repl.prompt()).toBe("reply→1 ›");
    expect(repl.mode()).toMatchObject({ kind: "reply-once", returnTo: "thread" });
  });
  it("falls back to where a once mode returns to if its post isn't known", async () => {
    const file = await saved();
    file.mode = { kind: "quote-once", target: "9", returnTo: "thread" };
    const { repl, agent } = setup();
    agent.getPosts.mockResolvedValueOnce(alive(2, 1) as never);
    await repl.resume(file);
    expect(repl.mode().kind).toBe("thread");
  });
  it("goes idle from a once mode if the thread it returns to has gone", async () => {
    const file = await saved({ then: (s) => s.repl.post().then(() => undefined) });
    const { repl, agent } = setup();
    agent.getPosts.mockResolvedValueOnce([]);
    await repl.resume(file);
    expect(repl.mode()).toEqual({ kind: "post-once", returnTo: "idle" });
  });

  describe("while it's still checking", () => {
    it("has the whole session from the start, so a save then loses nothing", async () => {
      const file = await saved({
        then: async (s) => {
          await s.repl.attach(["/x/a.png"]);
          await s.repl.reply("1");
        },
      });
      const { repl, agent, flush } = setup();
      agent.getPosts.mockImplementationOnce(() => new Promise(() => {}));
      void repl.resume(file);
      await flush();
      const now = repl.snapshot(meta, { text: "", cursor: 0 }, []);
      expect(now.thread).toEqual(file.thread);
      expect(now.mode).toEqual(file.mode);
      expect(now.staged).toEqual(file.staged);
      expect(now.posts).toHaveLength(2);
    });
    it("gives up on a check that hangs, keeping the thread", async () => {
      const file = await saved();
      const { repl, agent, printed } = setup();
      agent.getPosts.mockImplementationOnce(() => new Promise(() => {}));
      const done = repl.resume(file);
      await vi.advanceTimersByTimeAsync(10_000);
      await done;
      expect(repl.thread()?.cursor).toEqual(ref(2));
      expect(printed()).toContain("Couldn't check the thread (timed out)");
    });
  });

  describe("with unsent posts", () => {
    const twoQueued = () =>
      saved({
        settings: { undo: 0 },
        then: async (s) => {
          s.repl.setCooldown("undo", 5);
          await s.repl.submitText("first");
          await s.repl.submitText("second");
        },
      });
    const pendingNow = (r: { snapshot: Repl["snapshot"] }) => r.snapshot(meta, { text: "", cursor: 0 }, []).pending.map((p) => p.posts[0]);
    it("keeps them in the file until they're answered, so a kill at the question loses nothing", async () => {
      const file = await twoQueued();
      const answers: ((n: number) => void)[] = [];
      const choose = vi.fn(() => new Promise<number | undefined>((resolve) => answers.push(resolve)));
      const { repl, agent, flush, deps } = setup({ undo: 5 }, { choose });
      agent.getPosts.mockResolvedValueOnce(alive(2, 1) as never);
      void repl.resume(file);
      await flush();
      expect(pendingNow(repl)).toEqual(["first", "second"]);
      expect(repl.wouldLose("")).toBe(true);
      deps.onChange.mockClear();
      answers[0](2);
      await flush();
      expect(pendingNow(repl)).toEqual(["second"]);
      expect(deps.onChange).toHaveBeenCalled();
      answers[1](0);
      await flush();
      expect(pendingNow(repl)).toEqual(["second"]);
      expect(repl.pendingCount()).toBe(1);
    });
    it("goes after the cursor one by one, not all to the saved parent", async () => {
      const file = await twoQueued();
      file.pending[0].target = { parent: ref(7), root: ref(1) };
      file.pending[1].target = { parent: ref(7), root: ref(1) };
      const { repl, agent, flush } = setup({}, { choose: vi.fn(async () => 0) });
      agent.getPosts.mockResolvedValueOnce(alive(2, 1) as never);
      agent.post.mockResolvedValueOnce(ref(3)).mockResolvedValueOnce(ref(4));
      await repl.resume(file);
      await flush();
      expect(agent.post.mock.calls.map(([text, reply]) => [text, reply?.parent])).toEqual([["first", ref(2)], ["second", ref(3)]]);
    });
  });

  describe("with unsent posts", () => {
    const queued = () =>
      saved({
        settings: { undo: 0 },
        then: async (s) => {
          s.repl.setCooldown("undo", 5);
          await s.repl.submitText("waiting");
        },
      });
    const answering = (answer: number | undefined) => {
      const s = setup({ undo: 0 }, { choose: vi.fn(async () => answer) });
      s.agent.getPosts.mockResolvedValueOnce(alive(2, 1) as never);
      return s;
    };
    it("asks before sending anything", async () => {
      const file = await queued();
      const { repl, ask, agent, flush } = setup({ undo: 0 });
      agent.getPosts.mockResolvedValueOnce(alive(2, 1) as never);
      await repl.resume(file);
      await flush();
      expect(ask.choose).toHaveBeenCalledWith('Unsent from last time: "waiting"', ["Send", "Edit", "Discard"], 1);
      expect(agent.post).not.toHaveBeenCalled();
    });
    it("sends on Send, into the thread", async () => {
      const file = await queued();
      const { repl, posted, flush } = answering(0);
      await repl.resume(file);
      await flush();
      expect(posted).toMatchObject([{ text: "waiting", reply: { parent: ref(2), root: ref(1) } }]);
    });
    it("puts it in the composer on Edit", async () => {
      const file = await queued();
      const { repl, agent, deps, flush } = answering(1);
      await repl.resume(file);
      await flush();
      expect(deps.restore).toHaveBeenCalledWith("waiting");
      expect(agent.post).not.toHaveBeenCalled();
    });
    it("treats dismissing the question as Edit, so nothing is lost or sent", async () => {
      const file = await queued();
      const { repl, agent, deps, flush } = answering(undefined);
      await repl.resume(file);
      await flush();
      expect(deps.restore).toHaveBeenCalledWith("waiting");
      expect(agent.post).not.toHaveBeenCalled();
    });
    it("saves it as a draft on Edit if the composer's in use", async () => {
      const file = await queued();
      const { repl, deps, flush } = answering(1);
      deps.composerBusy.mockReturnValue(true);
      await repl.resume(file);
      await flush();
      expect(deps.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ text: "waiting" }));
      expect(deps.restore).not.toHaveBeenCalled();
    });
    it("starts on Edit, since a post may already have gone", async () => {
      const file = await queued();
      const { repl, ask } = setup({ undo: 0 });
      await repl.resume(file);
      expect(vi.mocked(ask.choose).mock.lastCall?.[2]).toBe(1);
    });
    describe("when its thread can't be found", () => {
      const lost = (answer: number) => {
        const s = setup({ undo: 0 }, { choose: vi.fn(async () => answer) });
        s.agent.getPosts.mockResolvedValueOnce([]);
        return s;
      };
      it("says Send will start a new thread", async () => {
        const file = await queued();
        const { repl, ask } = lost(0);
        await repl.resume(file);
        expect(vi.mocked(ask.choose).mock.lastCall?.[0]).toBe(`Unsent from last time: "waiting" (its thread couldn't be found, so Send starts a new one)`);
      });
      it("carries on as a thread after Send", async () => {
        const file = await queued();
        const { repl, posted, flush } = lost(0);
        await repl.resume(file);
        await flush();
        expect(posted).toMatchObject([{ text: "waiting" }]);
        expect(posted[0].reply).toBeUndefined();
        expect(repl.mode().kind).toBe("thread");
      });
      it("doesn't point Edit at a post it couldn't find", async () => {
        const file = await queued();
        const { repl, deps, flush } = lost(1);
        await repl.resume(file);
        await flush();
        expect(deps.restore).toHaveBeenCalledWith("/thread waiting");
      });
    });
    describe("that came from a draft", () => {
      const fromDraft = async () => {
        const file = await queued();
        file.pending[0].draftId = "d9";
        return file;
      };
      it("deletes the draft once it's sent, so draft sync can't send it again", async () => {
        const file = await fromDraft();
        const { repl, deps, flush } = answering(0);
        await repl.resume(file);
        await flush();
        expect(deps.deleteDraft).toHaveBeenCalledWith("d9");
      });
      it.each([["Edit", 1], ["Discard", 2]])("keeps the draft on %s, as nothing was sent", async (_, answer) => {
        const file = await fromDraft();
        const { repl, deps, flush } = answering(answer);
        await repl.resume(file);
        await flush();
        expect(deps.deleteDraft).not.toHaveBeenCalled();
      });
      it("keeps the draft while the question's open", async () => {
        const file = await fromDraft();
        const { repl, deps, flush } = setup({}, { choose: vi.fn(() => new Promise<undefined>(() => {})) });
        void repl.resume(file);
        await flush();
        expect(deps.deleteDraft).not.toHaveBeenCalled();
        expect(repl.snapshot(meta, { text: "", cursor: 0 }, []).pending[0].draftId).toBe("d9");
      });
    });
    it("restages media on Edit, and sends it to a draft with its text if it doesn't fit", async () => {
      const file = await saved({
        settings: { undo: 0 },
        then: async (s) => {
          s.repl.setCooldown("undo", 5);
          await s.repl.attach(["/x/a.png"]);
          await s.repl.submitText("waiting");
        },
      });
      const fits = answering(1);
      await fits.repl.resume(file);
      await fits.flush();
      expect(fits.repl.staged().map((m) => m.path)).toEqual(["/x/a.png"]);
      file.staged = [{ path: "/x/b.mp4", kind: "video" }];
      const clashes = answering(1);
      await clashes.repl.resume(file);
      await clashes.flush();
      expect(clashes.repl.staged().map((m) => m.path)).toEqual(["/x/b.mp4"]);
      expect(clashes.deps.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ text: "waiting", images: ["/x/a.png"] }));
    });
    it("forgets it on Discard", async () => {
      const file = await queued();
      const { repl, agent, deps, flush } = answering(2);
      await repl.resume(file);
      await flush();
      expect(agent.post).not.toHaveBeenCalled();
      expect(deps.restore).not.toHaveBeenCalled();
      expect(deps.saveDraft).not.toHaveBeenCalled();
    });
    it("sends what's left of a batch to where it was going", async () => {
      const file = await saved({
        then: async (s) => {
          s.repl.setCooldown("pace", 5);
          await s.repl.post("a /// b");
          await vi.advanceTimersByTimeAsync(5000);
        },
      });
      file.thread = undefined;
      const { repl, posted, flush } = setup({ pace: 0 }, { choose: vi.fn(async () => 0) });
      await repl.resume(file);
      await flush();
      expect(posted.map((p) => p.text)).toEqual(["b"]);
      expect(posted[0].reply?.parent).toEqual(file.pending[0].target?.parent);
    });
    it("sends media and quotes with what they went with", async () => {
      const file = await saved({
        settings: { undo: 0 },
        then: async (s) => {
          s.repl.setCooldown("undo", 5);
          await s.repl.attach(["/x/a.png"]);
          await s.repl.post("with media");
          await s.repl.quote("1", "a quote");
        },
      });
      const { repl, agent, posted, flush } = setup({}, { choose: vi.fn(async () => 0) });
      agent.getPosts.mockResolvedValueOnce(alive(2, 1) as never);
      await repl.resume(file);
      await flush();
      expect(posted).toMatchObject([{ text: "with media", media: [{ path: "/x/a.png" }] }, { text: "a quote", quote: ref(1) }]);
    });
  });
});

describe("snapshot", () => {
  const meta = { id: "k3f7xq", createdAt: "2026-11-04T09:00:00.000Z", handle: "me.bsky.social", did: me } as never;
  const composer = { text: "half a thought", cursor: 4 };
  const reread = (file: unknown) => parseSessionFile(JSON.parse(JSON.stringify(file)));
  it("holds the whole session, and passes the file's own checks", async () => {
    const { repl, flush } = setup({ undo: 5 });
    repl.setCooldown("undo", 0);
    await repl.startThread("one");
    await flush();
    await repl.reply("1");
    await repl.attach(["/x/a.png"]);
    repl.setCooldown("undo", 5);
    await repl.post("waiting");
    await repl.attach(["/x/b.png"]);
    const file = reread(repl.snapshot(meta, composer, ["/thread"]));
    expect(file).toMatchObject({
      version: 1,
      id: "k3f7xq",
      updatedAt: "2026-11-04T10:00:00.000Z",
      handle: "me.bsky.social",
      did: me,
      thread: { root: ref(1), cursor: ref(1), count: 1 },
      mode: { kind: "reply-once", target: "1", returnTo: "thread" },
      composer,
      staged: [{ path: "/x/b.png", kind: "image" }],
      history: ["/thread"],
      counters: { nextLabel: 2, nextViewed: 1, nextLetter: 0 },
    });
    expect(file.posts.map((p) => p.label)).toEqual(["1"]);
    expect(file.pending).toMatchObject([{ posts: ["waiting"], intent: { kind: "standalone" }, media: [{ path: "/x/a.png" }] }]);
    expect(file.settings).toMatchObject({ undo: 5, markers: DEFAULT_MARKERS });
  });
  it("includes a post in flight, which may or may not have gone", async () => {
    const { repl, agent, flush } = setup();
    agent.post.mockImplementationOnce(() => new Promise(() => {}));
    await repl.post("going");
    await flush();
    expect(reread(repl.snapshot(meta, composer, [])).pending).toMatchObject([{ posts: ["going"] }]);
  });
  it("has only the session's own fields, so no agent state can get in", async () => {
    const { repl } = setup();
    expect(Object.keys(repl.snapshot(meta, composer, [])).sort()).toEqual(
      ["composer", "counters", "createdAt", "did", "handle", "history", "id", "lastThreadLetter", "loaded", "mode", "pending", "posts", "settings", "staged", "thread", "updatedAt", "version", "viewed"].sort(),
    );
  });
});

describe("changes that aren't posts", () => {
  it("are reported, so they get saved", async () => {
    const { repl, deps, flush } = setup();
    deps.onChange.mockClear();
    repl.setAutoThread(true);
    expect(deps.onChange).toHaveBeenCalled();
    deps.onChange.mockClear();
    repl.setCooldown("undo", 5);
    expect(deps.onChange).toHaveBeenCalled();
    repl.setCooldown("undo", 0);
    await repl.post();
    deps.onChange.mockClear();
    await repl.submitText("hello");
    await flush();
    expect(repl.mode().kind).toBe("idle");
    expect(deps.onChange).toHaveBeenCalled();
  });
});

describe("/delete and /undo", () => {
  const written = async (answers: Partial<ReplAsk> = {}, posts = ["one", "two"]) => {
    const s = setup({}, answers);
    await s.repl.startThread();
    for (const text of posts) {
      await s.repl.submitText(text);
      await s.flush();
    }
    return s;
  };
  it("asks first, showing the post", async () => {
    const { repl, ask, agent, printed } = await written();
    expect(await repl.deletePost("2")).toBe("done");
    expect(ask.yesNo).toHaveBeenCalledWith('Delete (2) "two"?');
    expect(agent.deletePost).toHaveBeenCalledWith(ref(2).uri);
    expect(printed()).toContain("Deleted (2)");
  });
  it("does nothing on no", async () => {
    const { repl, agent } = await written({ yesNo: vi.fn(async () => false) });
    expect(await repl.deletePost("2")).toBe("done");
    expect(agent.deletePost).not.toHaveBeenCalled();
  });
  it("won't touch someone else's post", async () => {
    const { repl, ask, agent, printed } = await written();
    const uri = "at://did:plc:alice/app.bsky.feed.post/3lbx7kt5def2x";
    repl.labelPost({ uri, cid: "bafyabc" });
    agent.getPosts.mockResolvedValueOnce([{ uri, cid: "bafyabc", authorDid: "did:plc:alice", authorHandle: "alice.bsky.social", text: "" }] as never);
    expect(await repl.deletePost("#1")).toBe("keep");
    expect(printed()).toContain("You can only delete your own posts");
    expect(ask.yesNo).not.toHaveBeenCalled();
  });
  it("says if a post has already gone", async () => {
    const { repl, agent, printed } = await written();
    await repl.deletePost("2");
    agent.deletePost.mockClear();
    expect(await repl.deletePost("2")).toBe("keep");
    expect(printed()).toContain("(2) is already deleted");
    expect(agent.deletePost).not.toHaveBeenCalled();
  });
  it("keeps the post if the delete fails", async () => {
    const { repl, agent } = await written();
    agent.deletePost.mockRejectedValueOnce(new Error("fetch failed"));
    await expect(repl.deletePost("2")).rejects.toThrow("fetch failed");
    expect(repl.registry.byLabel("2")?.deleted).toBeUndefined();
    expect(repl.thread()?.cursor).toEqual(ref(2));
  });
  it("moves the thread back to the post before", async () => {
    const { repl, posted, flush } = await written();
    await repl.deletePost("2");
    expect(repl.thread()?.cursor).toEqual(ref(1));
    await repl.submitText("three");
    await flush();
    expect(posted[2].reply?.parent).toEqual(ref(1));
  });
  it("stops the thread if nothing of it is left", async () => {
    const { repl } = await written({}, ["one"]);
    await repl.deletePost("1");
    expect(repl.thread()).toBeUndefined();
    expect(repl.mode().kind).toBe("idle");
  });
  it("leaves the thread where it is when another post goes", async () => {
    const { repl } = await written({}, ["one", "two", "three"]);
    await repl.deletePost("2");
    expect(repl.thread()?.cursor).toEqual(ref(3));
  });
  it("skips every deleted post on the way back", async () => {
    const { repl } = await written({}, ["one", "two", "three"]);
    await repl.deletePost("2");
    await repl.deletePost("3");
    expect(repl.thread()?.cursor).toEqual(ref(1));
  });
  it("stops the thread with its root, and says so first", async () => {
    const { repl, ask } = await written({}, ["one", "two", "three"]);
    await repl.deletePost("1");
    expect(ask.yesNo).toHaveBeenCalledWith('Delete (1) "one"? This stops the thread.');
    expect(repl.thread()).toBeUndefined();
  });
  it("waits for what's queued, which may be replying to it", async () => {
    const { repl, agent, printed } = await written();
    repl.setCooldown("undo", 5);
    await repl.submitText("waiting");
    expect(await repl.deletePost("1")).toBe("keep");
    expect(agent.deletePost).not.toHaveBeenCalled();
    expect(printed()).toContain("Wait for pending posts");
  });
  it("can't be aimed at afterwards", async () => {
    const { repl, agent, printed } = await written({}, ["one", "two", "three"]);
    await repl.deletePost("2");
    for (const aim of [() => repl.reply("2", "hi"), () => repl.quote("2", "hi"), () => repl.replyFrom("2"), () => repl.engage("like", "2"), () => repl.openPost("2")]) {
      expect(await aim()).toBe("keep");
    }
    expect(printed()).toContain("(2) is already deleted");
    expect(agent.post).toHaveBeenCalledTimes(3);
    expect(agent.like).not.toHaveBeenCalled();
  });
  it("closes a prompt aimed at it", async () => {
    const { repl } = await written({}, ["one", "two", "three"]);
    await repl.reply("2");
    await repl.deletePost("2");
    expect(repl.mode().kind).toBe("thread");
  });
  it("leaves a prompt aimed at something else", async () => {
    const { repl } = await written({}, ["one", "two", "three"]);
    await repl.reply("3");
    await repl.deletePost("2");
    expect(repl.mode().kind).toBe("reply-once");
  });
  it("/undo leaves a post you only replied to", async () => {
    const { repl, agent, flush } = await written({}, ["one"]);
    const older = "at://did:plc:me/app.bsky.feed.post/3lbx7kt5aaa2a";
    agent.getPosts.mockResolvedValueOnce([{ uri: older, cid: "bafyabc", authorDid: me, authorHandle: "me.bsky.social", text: "old" }] as never);
    await repl.reply(older, "hi");
    await flush();
    await repl.undo();
    await repl.undo();
    expect(agent.deletePost.mock.calls.flat()).not.toContain(older);
  });
  it("/undo takes the last post you made", async () => {
    const { repl, agent } = await written();
    await repl.undo();
    await repl.undo();
    expect(agent.deletePost.mock.calls.map(([uri]) => uri)).toEqual([ref(2).uri, ref(1).uri]);
  });
  it("/undo says when there's nothing to take back", async () => {
    const { repl, printed } = setup();
    expect(await repl.undo()).toBe("keep");
    expect(printed()).toContain("Nothing to undo");
  });
  it("/undo waits for what's queued, which Esc takes back", async () => {
    const { repl, agent } = await written();
    repl.setCooldown("undo", 5);
    await repl.submitText("waiting");
    expect(await repl.undo()).toBe("keep");
    expect(agent.deletePost).not.toHaveBeenCalled();
  });
  it("is left out of the count, and survives a resume", async () => {
    const { repl } = await written();
    await repl.deletePost("2");
    const file = parseSessionFile(JSON.parse(JSON.stringify(repl.snapshot({ id: "k3f7xq", createdAt: "2026-11-04T09:00:00.000Z", handle: "me.bsky.social", did: me } as never, { text: "", cursor: 0 }, []))));
    expect(file.posts[1].deleted).toBe(true);
  });
});

describe("/drafts", () => {
  const draft = (o: Partial<Draft> = {}): Draft => ({ id: "1741392000000-a7f3", createdAt: "2026-11-04T09:00:00.000Z", reason: "manual", type: "post", text: "hello", ...o });
  const withDrafts = (...drafts: Draft[]) => {
    const s = setup();
    s.deps.listDrafts.mockResolvedValue(drafts);
    return s;
  };
  it("lists them", async () => {
    const { repl, printed } = withDrafts(draft(), draft({ id: "1741392000001-b2c4", type: "thread", text: "first line\nmore" }));
    expect(await repl.drafts()).toBe("done");
    expect(printed()).toContain("1741392000000-a7f3  post  hello");
    expect(printed()).toContain("1741392000001-b2c4  thread  first line");
  });
  it("says when there are none", async () => {
    const { repl, printed } = withDrafts();
    await repl.drafts();
    expect(printed()).toContain("No drafts");
  });
  it("loads one into the composer by id or the start of one", async () => {
    const { repl } = withDrafts(draft());
    await expect(repl.drafts("1741392000000-a7f3")).resolves.toEqual({ restore: "/post hello" });
    await expect(repl.drafts("17413")).resolves.toEqual({ restore: "/post hello" });
  });
  it("joins a thread's posts", async () => {
    const { repl } = withDrafts(draft({ type: "thread", posts: [{ text: "a" }, { text: "b" }] }));
    await expect(repl.drafts("17")).resolves.toEqual({ restore: "/post a /// b" });
  });
  it("keeps what it replies to or quotes", async () => {
    const reply = withDrafts(draft({ type: "reply", replyUri: ref(1).uri }));
    await expect(reply.repl.drafts("17")).resolves.toEqual({ restore: `/reply ${ref(1).uri} hello` });
    const quote = withDrafts(draft({ type: "quote", quoteUri: ref(1).uri }));
    await expect(quote.repl.drafts("17")).resolves.toEqual({ restore: `/quote ${ref(1).uri} hello` });
  });
  it("stages its media", async () => {
    const { repl } = withDrafts(draft({ images: ["/x/a.png"], imageAlts: ["A chart"] }));
    await repl.drafts("17");
    expect(repl.staged()).toEqual([{ path: "/x/a.png", kind: "image", alt: "A chart" }]);
  });
  it("stages a thread's media from its first post", async () => {
    const { repl } = withDrafts(draft({ type: "thread", posts: [{ text: "a", video: "/x/a.mp4", videoAlt: "A clip" }, { text: "b" }] }));
    await repl.drafts("17");
    expect(repl.staged()).toEqual([{ path: "/x/a.mp4", kind: "video", alt: "A clip" }]);
  });
  it("won't load one whose later posts have media, which only the first can carry here", async () => {
    const { repl, printed } = withDrafts(draft({ type: "thread", posts: [{ text: "a" }, { text: "b", images: ["/x/a.png"] }] }));
    expect(await repl.drafts("17")).toBe("keep");
    expect(printed()).toContain("Media on later posts can't be loaded here: use bsky drafts send");
  });
  it("won't load one whose media can't join what's staged", async () => {
    const { repl, printed } = withDrafts(draft({ images: ["/x/a.png"] }));
    await repl.attach(["/x/b.mp4"]);
    expect(await repl.drafts("17")).toBe("keep");
    expect(printed()).toContain("/detach what's staged first");
  });
  it("deletes the draft only once what was loaded has gone", async () => {
    const { repl, deps, flush } = withDrafts(draft());
    await repl.drafts("17");
    expect(deps.deleteDraft).not.toHaveBeenCalled();
    await repl.post("hello");
    await flush();
    expect(deps.deleteDraft).toHaveBeenCalledExactlyOnceWith("1741392000000-a7f3");
  });
  it("keeps the draft if the server refuses it, and the text comes back", async () => {
    const { repl, deps, agent, flush } = withDrafts(draft());
    await repl.drafts("17");
    agent.post.mockRejectedValueOnce(rejected());
    await repl.post("hello");
    await flush();
    expect(deps.restore).toHaveBeenCalledWith("/post hello");
    expect(deps.deleteDraft).not.toHaveBeenCalled();
  });
  it("keeps the draft if you post something else", async () => {
    const { repl, deps, flush } = withDrafts(draft());
    await repl.drafts("17");
    await repl.post("something else");
    await flush();
    expect(deps.deleteDraft).not.toHaveBeenCalled();
  });
  it("says if nothing matches, or too much does", async () => {
    const { repl, printed } = withDrafts(draft(), draft({ id: "1741392000001-b2c4" }));
    expect(await repl.drafts("99")).toBe("keep");
    expect(printed()).toContain('No draft "99"');
    expect(await repl.drafts("17")).toBe("keep");
    expect(printed()).toContain('"17" could be 1741392000000-a7f3 or 1741392000001-b2c4');
  });
});

describe("/switch", () => {
  const other = (s: ReturnType<typeof setup>) => ({ ...s.agent, selfDid: "did:plc:work" as Did, post: vi.fn(async () => ref(9)) });
  it("posts as the new account, and says so", async () => {
    const s = setup();
    const agent = other(s);
    s.deps.switchAccount.mockResolvedValueOnce({ agent, handle: "work.bsky.social" });
    expect(await s.repl.switchProfile("work")).toBe("done");
    expect(s.deps.switchAccount).toHaveBeenCalledWith("work");
    expect(s.printed()).toContain("Now posting as @work.bsky.social");
    await s.repl.post("hello");
    await s.flush();
    expect(agent.post).toHaveBeenCalled();
    expect(s.agent.post).not.toHaveBeenCalled();
  });
  it("waits for what's queued, which belongs to this account", async () => {
    const { repl, deps } = setup({ undo: 5 });
    await repl.post("waiting");
    expect(await repl.switchProfile("work")).toBe("keep");
    expect(deps.switchAccount).not.toHaveBeenCalled();
  });
  it("stops the thread, which belongs to this account", async () => {
    const { repl, flush, printed } = setup();
    await repl.startThread("one");
    await flush();
    await repl.switchProfile("work");
    expect(repl.thread()).toBeUndefined();
    expect(repl.mode().kind).toBe("idle");
    expect(printed()).toContain("Thread stopped");
  });
  it("leaves a reply or quote prompt, whose target was this account's choice", async () => {
    const { repl, flush } = setup();
    await repl.post("one");
    await flush();
    await repl.reply("1");
    await repl.switchProfile("work");
    expect(repl.mode().kind).toBe("idle");
  });
  it("clears staged media, with a warning", async () => {
    const { repl, printed } = setup();
    await repl.attach(["/x/a.png"]);
    await repl.switchProfile("work");
    expect(repl.staged()).toEqual([]);
    expect(printed()).toContain("Unstaged 📎 a.png");
  });
  it("changes nothing if the account can't be opened", async () => {
    const { repl, deps, flush } = setup();
    await repl.startThread("one");
    await flush();
    deps.switchAccount.mockRejectedValueOnce(new Error("Not logged in"));
    await expect(repl.switchProfile("work")).rejects.toThrow("Not logged in");
    expect(repl.thread()).toBeDefined();
  });
  it("won't delete the old account's posts as the new one", async () => {
    const s = setup();
    await s.repl.post("one");
    await s.flush();
    s.deps.switchAccount.mockResolvedValueOnce({ agent: other(s), handle: "work.bsky.social" });
    await s.repl.switchProfile("work");
    expect(await s.repl.deletePost("1")).toBe("keep");
    expect(s.printed()).toContain("You can only delete your own posts");
    expect(await s.repl.undo()).toBe("keep");
    expect(s.printed()).toContain("Nothing to undo");
  });
});

describe("/open, /copy and /view", () => {
  const url = `https://bsky.app/profile/${me}/post/${ref(1).uri.split("/").pop()}`;
  const withPost = async () => {
    const s = setup();
    await s.repl.post("first");
    await s.flush();
    return s;
  };
  it("/open opens a post in the browser", async () => {
    const { repl, deps } = await withPost();
    expect(await repl.openPost("1")).toBe("done");
    expect(deps.openUrl).toHaveBeenCalledWith(url);
  });
  it("/copy copies a post's link, and says so", async () => {
    const { repl, deps, printed } = await withPost();
    expect(await repl.copyPost("1")).toBe("done");
    expect(deps.copyText).toHaveBeenCalledWith(url);
    expect(printed()).toContain("Copied (1)");
  });
  it("/view finds the post's URI", async () => {
    const { repl } = await withPost();
    await expect(repl.uriOf("1")).resolves.toBe(ref(1).uri);
  });
  it("keep the text on a bad ref", async () => {
    const { repl, deps } = await withPost();
    expect(await repl.openPost("9")).toBe("keep");
    expect(await repl.copyPost("9")).toBe("keep");
    await expect(repl.uriOf("9")).resolves.toBeUndefined();
    expect(deps.openUrl).not.toHaveBeenCalled();
  });
});

describe("likes and reposts", () => {
  const withPost = async () => {
    const s = setup();
    await s.repl.post("first");
    await s.flush();
    return s;
  };
  it.each([
    ["like", "Liked (1)"],
    ["unlike", "Unliked (1)"],
    ["repost", "Reposted (1)"],
    ["unrepost", "Removed your repost of (1)"],
  ] as const)("%s a post by its label", async (action, message) => {
    const { repl, agent, printed } = await withPost();
    expect(await repl.engage(action, "1")).toBe("done");
    expect(agent[action]).toHaveBeenCalledWith(ref(1));
    expect(printed()).toContain(message);
  });
  it("work on a post you read", async () => {
    const { repl, agent } = await withPost();
    const uri = "at://did:plc:alice/app.bsky.feed.post/3lbx7kt5def2x";
    repl.labelPost({ uri, cid: "bafyabc" });
    agent.getPosts.mockResolvedValueOnce([{ uri, cid: "bafyabc", authorDid: "did:plc:alice", authorHandle: "alice.bsky.social", text: "" }] as never);
    await repl.engage("like", "#1");
    expect(agent.like).toHaveBeenCalledWith({ uri, cid: "bafyabc" });
  });
  it("say so if there's nothing to undo", async () => {
    const { repl, agent, printed } = await withPost();
    agent.unlike.mockResolvedValueOnce(false);
    agent.unrepost.mockResolvedValueOnce(false);
    await repl.engage("unlike", "1");
    await repl.engage("unrepost", "1");
    expect(printed()).toContain("You hadn't liked (1)");
    expect(printed()).toContain("You hadn't reposted (1)");
  });
  it("keep the text when the ref is wrong", async () => {
    const { repl, agent } = await withPost();
    expect(await repl.engage("like", "9")).toBe("keep");
    expect(agent.like).not.toHaveBeenCalled();
  });
});

describe("posts you read", () => {
  const seen = (n: number) => ({ uri: `at://did:plc:alice/app.bsky.feed.post/3lbx7kt5def${letter(n)}b`, cid: `bafy${letter(n)}` });
  it("get #n, and keep it", () => {
    const { repl } = setup();
    expect(repl.labelPost(seen(1))).toBe("#1");
    expect(repl.labelPost(seen(2))).toBe("#2");
    expect(repl.labelPost(seen(1))).toBe("#1");
  });
  it("show their own label if you wrote them", async () => {
    const { repl, flush } = setup();
    await repl.post("mine");
    await flush();
    expect(repl.labelPost({ uri: ref(1).uri, cid: ref(1).cid })).toBe("(1)");
  });
  it("go without a label if the API sends something odd", () => {
    const { repl } = setup();
    expect(repl.labelPost({ uri: "nonsense", cid: "x" })).toBeUndefined();
  });
  it("don't redraw from inside the command printing them", () => {
    const { repl, deps } = setup();
    deps.onChange.mockClear();
    repl.labelPost(seen(1));
    expect(deps.onChange).not.toHaveBeenCalled();
  });
  it("can be replied to", async () => {
    const { repl, agent, posted, flush } = setup();
    const post = { ...seen(1), cid: "bafyabc", authorDid: "did:plc:alice", authorHandle: "alice.bsky.social", text: "hi" };
    repl.labelPost(post);
    agent.getPosts.mockResolvedValueOnce([post] as never);
    await repl.reply("#1", "hello");
    await flush();
    expect(posted[0].reply?.parent.uri).toBe(post.uri);
  });
  it("expand in CLI arguments, but only as a whole argument", () => {
    const { repl } = setup();
    repl.labelPost(seen(1));
    expect(repl.expandLabels(["thread", "#1", "-n", "5", "#12", "see #1"], new Set([1, 4, 5]))).toEqual(["thread", seen(1).uri, "-n", "5", "#12", "see #1"]);
  });
  it("keep #n across a resume, and new ones carry on", async () => {
    const first = setup();
    first.repl.labelPost(seen(1));
    await first.repl.post("mine");
    await first.flush();
    const file = parseSessionFile(JSON.parse(JSON.stringify(first.repl.snapshot({ id: "k3f7xq", createdAt: "2026-11-04T09:00:00.000Z", handle: "me.bsky.social", did: me } as never, { text: "", cursor: 0 }, []))));
    expect(file.viewed).toHaveLength(1);
    const { repl } = setup();
    await repl.resume(file);
    expect(repl.labelPost(seen(1))).toBe("#1");
    expect(repl.labelPost(seen(2))).toBe("#2");
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
  it("leaves the thread where it was, so the next post doesn't reply to the quote", async () => {
    const { repl, posted, flush } = setup();
    await repl.startThread("one");
    await flush();
    await repl.quote("1", "look");
    await flush();
    await repl.submitText("two");
    await flush();
    expect(posted[2].reply?.parent).toEqual(ref(1));
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
  it("keeps media staged if a draft can't be saved", async () => {
    const { repl, deps } = setup({}, pick("Draft"));
    deps.saveDraft.mockRejectedValueOnce(new Error("EACCES"));
    await repl.attach(["/x/a.png"]);
    await repl.newMenu();
    await expect(repl.submitText("later")).rejects.toThrow("EACCES");
    expect(repl.staged()).toHaveLength(1);
  });
  it("hands back text kept for later from a draft", async () => {
    const { repl } = setup({}, pick("Draft"));
    await repl.newMenu();
    expect(await repl.submitText("now //> later")).toEqual({ restore: "later" });
  });
  it("takes a quoted path, as a drag into the prompt gives", async () => {
    const { repl } = setup({}, { ...pick("Image post"), text: vi.fn(async () => "'/x/a b.png'") });
    await repl.newMenu();
    expect(repl.staged().map((m) => m.path)).toEqual(["/x/a b.png"]);
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
    expect(printed()).toContain("Nothing sends it until a scheduler runs for this account: `bsky schedule enable`, or `bsky schedule watch` in another terminal");
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
  it("take the morning when you say AM", async () => {
    const choose = vi.fn(async (label: string, options: readonly string[]) => (label === "New:" ? options.indexOf("Scheduled post") : 0));
    const { repl, deps } = setup({}, { ...answers("05-11-2026", "3:30"), choose });
    await repl.newMenu();
    await repl.submitText("later");
    expect(deps.saveScheduled).toHaveBeenCalledWith(expect.objectContaining({ scheduledAt: new Date(2026, 10, 5, 3, 30).toISOString() }));
  });
  it("aren't saved if you back out at the time or at AM or PM", async () => {
    const atTime = setup({}, answers("05-11-2026", undefined));
    await atTime.repl.newMenu();
    expect(await atTime.repl.submitText("later")).toBe("keep");
    expect(atTime.deps.saveScheduled).not.toHaveBeenCalled();
    const choose = vi.fn(async (label: string, options: readonly string[]) => (label === "New:" ? options.indexOf("Scheduled post") : undefined));
    const atHalf = setup({}, { ...answers("05-11-2026", "3:30"), choose });
    await atHalf.repl.newMenu();
    expect(await atHalf.repl.submitText("later")).toBe("keep");
    expect(atHalf.deps.saveScheduled).not.toHaveBeenCalled();
  });
  it("keep their media if the save fails", async () => {
    const { repl, deps } = setup({}, answers("05-11-2026", "15:30"));
    deps.saveScheduled.mockRejectedValueOnce(new Error("EACCES"));
    await repl.attach(["/x/a.png"]);
    await repl.newMenu();
    await expect(repl.submitText("later")).rejects.toThrow("EACCES");
    expect(repl.staged()).toHaveLength(1);
    expect(repl.mode().kind).toBe("schedule-once");
  });
  it("hand back text kept for later", async () => {
    const { repl } = setup({}, answers("05-11-2026", "15:30"));
    await repl.newMenu();
    expect(await repl.submitText("now //> later")).toEqual({ restore: "later" });
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
