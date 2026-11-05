import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Repl, type ReplAsk, type ReplSettings } from "./repl";
import { DEFAULT_MARKERS } from "./markers";
import { SessionStore, parseSessionFile, type ReplSessionFile } from "./persist";
import type { AtUri, Cid, Did, Handle, IsoUtc, SessionId, StrongRef } from "./types";
import type { Draft } from "@/lib/types";
import type { MediaFs } from "./media";

const me = "did:plc:me" as Did;
const L = (n: number) => String.fromCharCode(97 + n);
const ref = (n: number): StrongRef => ({ uri: `at://${me}/app.bsky.feed.post/3lbx7kt5def${L(n % 26)}a` as AtUri, cid: `bafy${L(n % 26)}` as Cid });
const fs: MediaFs = { size: async (p) => (p.includes("missing") ? undefined : 10), head: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]) };
const rejected = () => Object.assign(new Error("Invalid record"), { status: 400 });
const meta = { id: "k3f7xq" as SessionId, createdAt: "2026-11-04T10:00:00.000Z" as IsoUtc, handle: "me.bsky.social" as Handle, did: me };

function setup(settings: Partial<ReplSettings> = {}, store = new Map<string, Draft>(), answers: Partial<ReplAsk> = {}) {
  let n = 0, ids = 0;
  const posted: string[] = [];
  const agent = {
    selfDid: me, resolveHandle: vi.fn(async () => me), getPosts: vi.fn(async () => [] as never[]),
    post: vi.fn(async (text: string) => { posted.push(text); return ref(++n); }),
    like: vi.fn(), unlike: vi.fn(), repost: vi.fn(), unrepost: vi.fn(), deletePost: vi.fn(),
  };
  const ask: ReplAsk = { cooldown: vi.fn(async () => 0 as const), saveOffer: vi.fn(async () => "no" as const), confirm: vi.fn(async () => true), alt: vi.fn(async () => undefined), choose: vi.fn(async () => undefined), text: vi.fn(async () => undefined), yesNo: vi.fn(async () => true), ...answers };
  const lines: string[] = [];
  const deps = {
    agent, ask, print: (t: string) => void lines.push(t), onChange: vi.fn(), restore: vi.fn(),
    saveDraft: vi.fn(async (d: Omit<Draft, "id" | "createdAt">) => { const id = `new${++ids}`; store.set(id, { ...d, id, createdAt: "2026-11-04T10:00:00.000Z" }); return { id }; }),
    deleteDraft: vi.fn(async (id: string) => { if (!store.delete(id)) throw new Error("ENOENT " + id); }),
    saveConfig: vi.fn(async () => {}), saveScheduled: vi.fn(async () => ({ id: "s1" })), composerBusy: vi.fn(() => false), schedulerRunning: vi.fn(() => true),
    openUrl: vi.fn(async () => {}), copyText: vi.fn(async () => {}), listDrafts: vi.fn(async () => [...store.values()]),
    switchAccount: vi.fn(async () => ({ agent, handle: "work.bsky.social" })), fs,
  };
  const repl = new Repl({ autoThread: false, prefixThread: false, threadLabel: false, undo: 0, pace: 0, askToSave: false, verbose: false, forceAlt: false, ...settings }, DEFAULT_MARKERS, deps as never);
  const flush = () => vi.advanceTimersByTimeAsync(0);
  return { repl, agent, deps, posted, flush, store, lines, printed: () => lines.join("\n") };
}
const draft = (o: Partial<Draft> = {}): Draft => ({ id: "d0", createdAt: "2026-11-04T09:00:00.000Z", reason: "manual", type: "post", text: "hello", ...o });
const withDraft = (s: Partial<ReplSettings>, d: Draft) => setup(s, new Map([[d.id, d]]));
const roundTrip = (f: ReplSessionFile) => parseSessionFile(JSON.parse(JSON.stringify(f)));
const texts = (st: Map<string, Draft>) => [...st.values()].map((d) => d.posts?.map((p) => p.text) ?? [d.text]);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-04T10:00:00Z")); });
afterEach(() => vi.useRealTimers());

describe("ESC", () => {
  it("undo window: draft stays, text back, resending it deletes it", async () => {
    const s = withDraft({ undo: 5 }, draft());
    await s.repl.drafts("d0");
    await s.repl.post("hello");
    expect(s.repl.escape("")).toEqual({ restore: "/post hello" });
    await s.flush();
    expect(s.store.has("d0")).toBe(true);
    await s.repl.post("hello");
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.posted).toEqual(["hello"]);
    expect(s.store.size).toBe(0);
  });
  it("composer busy: stays, no second draft", async () => {
    const s = withDraft({ undo: 5 }, draft());
    await s.repl.drafts("d0");
    await s.repl.post("hello");
    expect(s.repl.escape("typing")).toBe("handled");
    await s.flush();
    expect(s.store.size).toBe(1);
    expect(s.store.has("d0")).toBe(true);
  });
  it("Esc, clear the composer: still there", async () => {
    const s = withDraft({ undo: 5 }, draft());
    await s.repl.drafts("d0");
    await s.repl.post("hello");
    s.repl.escape("");
    await s.flush();
    await vi.advanceTimersByTimeAsync(10000);
    expect(texts(s.store)).toEqual([["hello"]]);
  });
});
describe("REJECT", () => {
  it("first post rejected: stays, text back, resend deletes", async () => {
    const s = withDraft({}, draft());
    await s.repl.drafts("d0");
    s.agent.post.mockRejectedValueOnce(rejected());
    await s.repl.post("hello"); await s.flush();
    expect(s.deps.restore).toHaveBeenCalledWith("/post hello");
    expect(s.store.has("d0")).toBe(true);
    await s.repl.post("hello"); await s.flush();
    expect(s.store.size).toBe(0);
  });
  it("rejected while typing: stays, no duplicate", async () => {
    const s = withDraft({}, draft());
    await s.repl.drafts("d0");
    s.agent.post.mockRejectedValueOnce(rejected());
    s.deps.composerBusy.mockReturnValue(true);
    await s.repl.post("hello"); await s.flush();
    expect([...s.store.keys()]).toEqual(["d0"]);
  });
  it("second post rejected: only what's unsent is in a draft", async () => {
    const s = withDraft({}, draft({ type: "thread", posts: [{ text: "a" }, { text: "b" }] }));
    await s.repl.drafts("d0");
    s.agent.post.mockImplementationOnce(async () => ref(1)).mockRejectedValueOnce(rejected());
    await s.repl.post("a /// b"); await s.flush();
    expect(texts(s.store)).toEqual([["b"]]);
    expect([...s.store.values()][0].replyUri).toBe(ref(1).uri);
  });
});
describe("NETWORK", () => {
  it("first post fails: the posts are in one draft, /retry empties it", async () => {
    const s = withDraft({}, draft());
    await s.repl.drafts("d0");
    s.agent.post.mockRejectedValueOnce(new Error("fetch failed"));
    await s.repl.post("hello"); await s.flush();
    expect(texts(s.store)).toEqual([["hello"]]);
    await s.repl.retry(); await s.flush();
    expect(s.store.size).toBe(0);
  });
  it("fails, /retry, Esc in a short rate-limit wait: still in a draft", async () => {
    const s = withDraft({}, draft());
    await s.repl.drafts("d0");
    s.agent.post.mockRejectedValueOnce(new Error("fetch failed"));
    await s.repl.post("hello"); await s.flush();
    const reset = String(Math.floor(Date.now() / 1000) + 30);
    s.agent.post.mockRejectedValueOnce(Object.assign(new Error("slow down"), { status: 429, headers: { "ratelimit-reset": reset } }));
    await s.repl.retry(); await s.flush();
    expect(s.repl.pendingCount()).toBe(1);
    expect(s.repl.escape("")).toEqual({ restore: "/post hello" });
    await s.flush();
    expect(texts(s.store)).toEqual([["hello"]]);
    await s.repl.post("hello"); await s.flush();
    expect(s.store.size).toBe(0);
  });
});
describe("PARTIAL", () => {
  it("Esc between posts: only the unsent posts survive, none sent", async () => {
    const s = withDraft({ pace: 5 }, draft({ type: "thread", posts: [{ text: "a" }, { text: "b" }, { text: "c" }] }));
    await s.repl.drafts("d0");
    await s.repl.post("a /// b /// c"); await s.flush();
    expect(s.posted).toEqual(["a"]);
    s.repl.escape(""); await s.flush();
    await vi.advanceTimersByTimeAsync(20000);
    expect(s.posted).toEqual(["a"]);
    expect(texts(s.store)).toEqual([["b", "c"]]);
  });
  it("Esc with the first post in flight, which lands", async () => {
    const s = withDraft({}, draft({ type: "thread", posts: [{ text: "a" }, { text: "b" }] }));
    await s.repl.drafts("d0");
    let land = (_: StrongRef) => {};
    s.agent.post.mockImplementationOnce(() => new Promise((r) => (land = r)));
    await s.repl.post("a /// b"); await s.flush();
    s.repl.escape(""); await s.flush();
    land(ref(1)); await s.flush();
    expect(texts(s.store)).toEqual([["b"]]);
  });
});
describe("EDIT", () => {
  it("post something else: stays", async () => {
    const s = withDraft({}, draft());
    await s.repl.drafts("d0");
    await s.repl.post("something else"); await s.flush();
    expect(s.store.has("d0")).toBe(true);
  });
  it("draft ending in a newline still matches", async () => {
    const s = withDraft({}, draft({ text: "hello\n" }));
    await s.repl.drafts("d0");
    await s.repl.post("hello"); await s.flush();
    expect(s.store.size).toBe(0);
  });
});
describe("RESUME", () => {
  it("loaded and in the composer at a kill: resent, deleted", async () => {
    const a = withDraft({}, draft());
    await a.repl.drafts("d0");
    const file = roundTrip(a.repl.snapshot(meta, { text: "/post hello", cursor: 11 }, []));
    const b = setup({}, a.store);
    await b.repl.resume(file); await b.flush();
    await b.repl.post("hello"); await b.flush();
    expect(b.posted).toEqual(["hello"]);
    expect(b.store.size).toBe(0);
  });
  const queued = async () => {
    const a = withDraft({ undo: 5 }, draft());
    await a.repl.drafts("d0");
    await a.repl.post("hello");
    return { store: a.store, file: roundTrip(a.repl.snapshot(meta, { text: "", cursor: 0 }, [])) };
  };
  it("queued at a kill, Edit: stays, then resent, deleted", async () => {
    const { store, file } = await queued();
    const b = setup({}, store, { choose: vi.fn(async () => 1) });
    await b.repl.resume(file); await b.flush();
    expect(b.store.has("d0")).toBe(true);
    await b.repl.post("hello"); await b.flush();
    expect(b.store.size).toBe(0);
  });
  it("queued at a kill, Discard: stays", async () => {
    const { store, file } = await queued();
    const b = setup({}, store, { choose: vi.fn(async () => 2) });
    await b.repl.resume(file); await b.flush();
    expect(b.store.has("d0")).toBe(true);
  });
  it("queued at a kill, Edit with the composer in use: no duplicate", async () => {
    const { store, file } = await queued();
    const b = setup({}, store, { choose: vi.fn(async () => 1) });
    b.deps.composerBusy.mockReturnValue(true);
    await b.repl.resume(file); await b.flush();
    expect([...b.store.keys()]).toEqual(["d0"]);
  });
});
describe("SWITCH", () => {
  it("the same words under the next account touch no draft", async () => {
    const s = withDraft({}, draft());
    await s.repl.drafts("d0");
    await s.repl.switchProfile("work");
    await s.repl.post("hello"); await s.flush();
    expect(s.deps.deleteDraft).not.toHaveBeenCalled();
  });
});
describe("SAVE", () => {
  const reply = () => withDraft({}, draft({ type: "reply", replyUri: ref(1).uri }));
  it("unchanged reply in the composer: nothing new to save", async () => {
    const s = reply();
    await s.repl.drafts("d0");
    expect(s.repl.composerDrafts(`/reply ${ref(1).uri} hello`)).toEqual([]);
  });
  it("edited reply keeps its destination", async () => {
    const s = reply();
    await s.repl.drafts("d0");
    expect(s.repl.composerDrafts(`/reply ${ref(1).uri} hello there`)).toEqual([{ reason: "manual", type: "reply", text: "hello there", replyUri: ref(1).uri }]);
  });
  it("edited quote keeps its destination", async () => {
    const s = setup();
    expect(s.repl.composerDrafts(`/quote ${ref(1).uri} hey`)).toEqual([{ reason: "manual", type: "quote", text: "hey", quoteUri: ref(1).uri }]);
  });
  it("typed /reply #n", async () => {
    const s = setup();
    s.repl.labelPost(ref(3));
    expect(s.repl.composerDrafts("/reply #1 hi")).toEqual([{ reason: "manual", type: "reply", text: "hi", replyUri: ref(3).uri }]);
  });
  it("queued loaded post on exit save: no duplicate of a draft that's still there", async () => {
    const s = withDraft({ undo: 5 }, draft());
    await s.repl.drafts("d0");
    await s.repl.post("hello");
    expect(s.repl.draftItems()).toEqual([]);
  });
  it("loaded with media, unchanged: nothing new", async () => {
    const s = withDraft({}, draft({ images: ["/x/a.png"] }));
    await s.repl.drafts("d0");
    expect(s.repl.composerDrafts("/post hello")).toEqual([]);
  });
  it("loaded, then another image attached: that image isn't lost", async () => {
    const s = withDraft({}, draft({ images: ["/x/a.png"] }));
    await s.repl.drafts("d0");
    await s.repl.attach(["/x/b.png"], "alt");
    expect(s.repl.composerDrafts("/post hello")).toMatchObject([{ images: ["/x/b.png"] }]);
  });
});
describe("EXTRA", () => {
  it("load, Esc, load again: the image isn't staged twice", async () => {
    const s = withDraft({ undo: 5 }, draft({ images: ["/x/a.png"] }));
    await s.repl.drafts("d0");
    await s.repl.post("hello");
    s.repl.escape("");
    await s.repl.drafts("d0");
    expect(s.repl.staged().length).toBe(1);
  });
  it("load twice: the image isn't staged twice", async () => {
    const s = withDraft({}, draft({ images: ["/x/a.png"] }));
    await s.repl.drafts("d0");
    await s.repl.drafts("d0");
    expect(s.repl.staged().length).toBe(1);
  });
  it("failed draft save on network, Esc: draft stays, text back", async () => {
    const s = withDraft({}, draft());
    await s.repl.drafts("d0");
    s.deps.saveDraft.mockRejectedValueOnce(new Error("EACCES"));
    s.agent.post.mockRejectedValueOnce(new Error("fetch failed"));
    await s.repl.post("hello"); await s.flush();
    expect(s.store.has("d0")).toBe(true);
    expect(s.repl.escape("")).toEqual({ restore: "/post hello" });
    await s.flush();
    expect(s.store.has("d0")).toBe(true);
  });
  it("close on exit with a queued loaded post keeps it", async () => {
    const s = withDraft({ undo: 5 }, draft());
    await s.repl.drafts("d0");
    await s.repl.post("hello");
    s.repl.close(); await s.flush();
    await vi.advanceTimersByTimeAsync(10000);
    expect(s.store.has("d0")).toBe(true);
    expect(s.posted).toEqual([]);
  });
  it("in-flight first post rejected after Esc: nothing lost", async () => {
    const s = withDraft({}, draft({ type: "thread", posts: [{ text: "a" }, { text: "b" }] }));
    await s.repl.drafts("d0");
    let fail = (_: Error) => {};
    s.agent.post.mockImplementationOnce(() => new Promise((_, r) => (fail = r)));
    await s.repl.post("a /// b"); await s.flush();
    s.repl.escape(""); await s.flush();
    fail(rejected()); await s.flush();
    expect(texts(s.store).flat()).toEqual(expect.arrayContaining(["a", "b"]));
    expect(s.deps.restore).toHaveBeenCalledWith("/post a");
  });
  it("quote draft Esc and back", async () => {
    const s = withDraft({ undo: 5 }, draft({ type: "quote", quoteUri: ref(1).uri }));
    s.agent.getPosts.mockResolvedValue([{ uri: ref(1).uri, cid: ref(1).cid, text: "x" }] as never);
    const out = await s.repl.drafts("d0");
    expect(out).toEqual({ restore: `/quote ${ref(1).uri} hello` });
    await s.repl.quote(ref(1).uri, "hello");
    const back = s.repl.escape("") as { restore: string };
    await s.flush();
    expect(s.repl.composerDrafts(back.restore)).toEqual([]);
    expect(s.store.has("d0")).toBe(true);
  });
  it("long draft auto-split, Esc, resend the split text: deleted", async () => {
    const long = "word ".repeat(100).trim();
    const s = withDraft({ undo: 5 }, draft({ reason: "length", text: long }));
    await s.repl.drafts("d0");
    await s.repl.post(long);
    const back = s.repl.escape("") as { restore: string };
    await s.flush();
    expect(s.store.has("d0")).toBe(true);
    await s.repl.post(back.restore.replace(/^\/post /, ""));
    await vi.advanceTimersByTimeAsync(5000);
    await s.flush();
    expect(s.repl.pendingCount()).toBe(0);
    expect(s.store.size).toBe(0);
  });
});
describe("RELATIVE", () => {
  it("real SessionStore accepts a session with a loaded create-thread draft", async () => {
    vi.useRealTimers();
    const dir = mkdtempSync(join(tmpdir(), "x-drafts-"));
    try {
      const s = withDraft({}, draft({ type: "thread", posts: [{ text: "a", images: ["pic.png"], imageAlts: ["x"] }, { text: "b" }] }));
      await s.repl.drafts("d0");
      await new SessionStore(dir).save(s.repl.snapshot(meta, { text: "/post a /// b", cursor: 0 }, []));
      expect(isAbsolute(s.repl.staged()[0].path)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("a draft whose file is gone isn't loaded, so sending can't delete the image with it", async () => {
    const s = withDraft({}, draft({ images: ["/x/missing.png"] }));
    expect(await s.repl.drafts("d0")).toBe("keep");
    expect(s.repl.staged()).toEqual([]);
  });
});
