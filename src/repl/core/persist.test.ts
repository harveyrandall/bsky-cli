import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { open, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, newSessionId, parseSessionFile, resolveId, type ReplSessionFile, type SessionListing } from "./persist";
import { isIsoUtc, isMarker, isSessionId, type SessionId } from "./types";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, rename: vi.fn(fs.rename), open: vi.fn(fs.open) };
});

const did = "did:plc:me";
const uri = (rkey: string) => `at://${did}/app.bsky.feed.post/${rkey}`;
const ref = (rkey: string) => ({ uri: uri(rkey), cid: `bafy${rkey}` });
const a = "3lbx7kt5def2a";
const b = "3lbx7kt5def2b";

const good = () =>
  ({
    version: 1,
    id: "k3f7xq",
    createdAt: "2026-11-04T10:00:00.000Z",
    updatedAt: "2026-11-04T10:05:00.000Z",
    handle: "me.bsky.social",
    did,
    profile: "work",
    settings: {
      autoThread: false,
      prefixThread: true,
      threadLabel: "append",
      undo: 5,
      pace: 0,
      verbose: false,
      forceAlt: true,
      askToSave: true,
      markers: { split: "///", send: "//>", cut: "<//" },
    },
    posts: [
      { label: "A1", ...ref(a), rkey: a, authorDid: did, root: ref(a), excerpt: "Launch day", letter: "A", notes: "📷 1" },
      { label: "A2", ...ref(b), rkey: b, authorDid: did, root: ref(a), parent: uri(a), excerpt: "second", letter: "A" },
    ],
    viewed: [],
    thread: { root: ref(a), cursor: ref(b), letter: "A", count: 2 },
    mode: { kind: "reply-once", target: "A1", returnTo: "thread" },
    composer: { text: "half a thought", cursor: 6 },
    staged: [{ path: "/x/a.png", kind: "image", alt: "A chart" }],
    pending: [
      { id: 3, intent: { kind: "thread" }, posts: ["next"], createdAt: 1000, target: { parent: ref(b), root: ref(a) } },
      { id: 4, intent: { kind: "quote", target: ref(a) }, posts: ["look"], createdAt: 1001 },
      { id: 5, intent: { kind: "reply", target: ref(a), root: ref(a) }, posts: ["hi"], createdAt: 1002, media: [{ path: "/x/b.png", kind: "image" }] },
    ],
    history: ["/thread", "first"],
    counters: { nextLabel: 3, nextViewed: 0, nextLetter: 1 },
  }) as unknown as ReplSessionFile;

type Mutable = Record<string, any>;
const breaks: [string, (f: Mutable) => void][] = [
  ["version", (f) => (f.version = 2)],
  ["id", (f) => (f.id = "NOPE!!")],
  ["createdAt", (f) => (f.createdAt = "yesterday")],
  ["updatedAt", (f) => (f.updatedAt = "2026-11-04T10:05:00+01:00")],
  ["handle", (f) => (f.handle = "not a handle")],
  ["did", (f) => (f.did = "did:nope")],
  ["profile", (f) => (f.profile = 7)],
  ["settings.undo", (f) => (f.settings.undo = 7)],
  ["settings.threadLabel", (f) => (f.settings.threadLabel = "sideways")],
  ["settings.markers.split", (f) => (f.settings.markers.split = "a b")],
  ["posts[0].uri", (f) => (f.posts[0].uri = "https://bsky.app")],
  ["posts[0].cid", (f) => (f.posts[0].cid = "Qm123")],
  ["posts[1].label", (f) => (f.posts[1].label = "a2")],
  ["posts[0].root", (f) => (f.posts[0].root = { uri: "x", cid: "y" })],
  ["posts[1].parent", (f) => (f.posts[1].parent = "x")],
  ["posts[0].excerpt", (f) => (f.posts[0].excerpt = 1)],
  ["thread.cursor", (f) => (f.thread.cursor = { uri: uri("nope"), cid: "b" })],
  ["thread.count", (f) => (f.thread.count = -1)],
  ["mode.kind", (f) => (f.mode.kind = "sideways")],
  ["mode.target", (f) => (f.mode.target = "not a label")],
  ["mode.returnTo", (f) => (f.mode.returnTo = "nowhere")],
  ["composer.text", (f) => (f.composer.text = 1)],
  ["composer.cursor", (f) => (f.composer.cursor = -1)],
  ["staged[0].kind", (f) => (f.staged[0].kind = "audio")],
  ["staged[0].path", (f) => (f.staged[0].path = "relative.png")],
  ["pending[0].intent", (f) => (f.pending[0].intent = { kind: "sideways" })],
  ["pending[0].posts", (f) => (f.pending[0].posts = [])],
  ["pending[0].target", (f) => (f.pending[0].target = { parent: ref(a) })],
  ["pending[2].media", (f) => (f.pending[2].media = [{ path: "b.png", kind: "image" }])],
  ["history", (f) => (f.history = [1])],
  ["counters.nextLabel", (f) => (f.counters.nextLabel = "3")],
];

describe("parseSessionFile", () => {
  it("accepts a good file, through JSON, unchanged", () => {
    const file = good();
    expect(parseSessionFile(JSON.parse(JSON.stringify(file)))).toEqual(file);
  });
  it("accepts a file with nothing optional", () => {
    const file = good() as Mutable;
    for (const key of ["profile", "thread"]) delete file[key];
    file.settings.undo = undefined;
    file.mode = { kind: "idle" };
    expect(() => parseSessionFile(JSON.parse(JSON.stringify(file)))).not.toThrow();
  });
  it.each(breaks)("refuses a bad %s, naming it", (field, spoil) => {
    const file = good() as Mutable;
    spoil(file);
    expect(() => parseSessionFile(file)).toThrow(`Session file: bad ${field}`);
  });
  it("refuses what isn't an object", () => {
    for (const raw of [null, 1, "text", []]) expect(() => parseSessionFile(raw)).toThrow("Session file");
  });
  it("refuses staged media a post couldn't hold, valid as each file is", () => {
    const file = good() as Mutable;
    file.staged.push({ path: "/x/c.mp4", kind: "video" });
    expect(() => parseSessionFile(file)).toThrow("Session file: bad staged");
  });
  it("refuses queued media a post couldn't hold", () => {
    const file = good() as Mutable;
    file.pending[2].media = [1, 2, 3, 4, 5].map((n) => ({ path: `/x/${n}.png`, kind: "image" }));
    expect(() => parseSessionFile(file)).toThrow("Session file: bad pending[2].media");
  });
  it("refuses a queued quote of two posts, or with media", () => {
    const two = good() as Mutable;
    two.pending[1].posts.push("more");
    expect(() => parseSessionFile(two)).toThrow("Session file: bad pending[1]");
    const media = good() as Mutable;
    media.pending[1].media = [{ path: "/x/b.png", kind: "image" }];
    expect(() => parseSessionFile(media)).toThrow("Session file: bad pending[1]");
  });
});

describe("guards", () => {
  it("isSessionId takes 6 base32 characters", () => {
    expect(isSessionId("k3f9xq")).toBe(false); // 9 isn't base32
    expect(isSessionId("k3f7xq")).toBe(true);
    expect(isSessionId("k3f7x")).toBe(false);
    expect(isSessionId("K3F7XQ")).toBe(false);
  });
  it("isIsoUtc takes a UTC timestamp only", () => {
    expect(isIsoUtc("2026-11-04T10:00:00.000Z")).toBe(true);
    expect(isIsoUtc("2026-11-04T10:00:00+01:00")).toBe(false);
    expect(isIsoUtc("2026-11-04")).toBe(false);
  });
  it("isMarker takes text with no spaces", () => {
    expect(isMarker("///")).toBe(true);
    expect(isMarker("")).toBe(false);
    expect(isMarker("a b")).toBe(false);
  });
});

describe("newSessionId", () => {
  it("makes a valid id", () => {
    expect(isSessionId(newSessionId())).toBe(true);
  });
});

describe("SessionStore", () => {
  let dir: string;
  let store: SessionStore;
  const id = (s: string) => s as SessionId;
  const session = (s: string, updatedAt = "2026-11-04T10:05:00.000Z") => ({ ...good(), id: id(s), updatedAt }) as ReplSessionFile;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bsky-sessions-"));
    store = new SessionStore(join(dir, "repl", "sessions"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const path = (s: string, ext = "json") => join(dir, "repl", "sessions", `${s}.${ext}`);

  it("saves a file only you can read, and loads it back", async () => {
    await store.save(session("aaaaaa"));
    expect(statSync(path("aaaaaa")).mode & 0o777).toBe(0o600);
    await expect(store.load(id("aaaaaa"))).resolves.toEqual(session("aaaaaa"));
  });
  it("keeps the old file when the write dies", async () => {
    await store.save(session("aaaaaa"));
    vi.mocked(rename).mockRejectedValueOnce(new Error("ENOSPC"));
    await expect(store.save({ ...session("aaaaaa"), history: ["newer"] })).rejects.toThrow("ENOSPC");
    expect((await store.load(id("aaaaaa"))).history).toEqual(good().history);
    expect(readdirSync(join(dir, "repl", "sessions"))).toEqual(["aaaaaa.json"]);
  });
  it("ignores a temp file a kill left behind", async () => {
    await store.save(session("aaaaaa"));
    writeFileSync(path("aaaaaa.123", "tmp"), "{ half a fi");
    await expect(store.list()).resolves.toHaveLength(1);
  });
  it("takes saves one at a time, so the last one wins", async () => {
    await Promise.all([1, 2, 3].map((n) => store.save({ ...session("aaaaaa"), history: [`${n}`] })));
    expect((await store.load(id("aaaaaa"))).history).toEqual(["3"]);
  });
  it("lists newest first, with a summary", async () => {
    await store.save(session("aaaaaa", "2026-11-03T10:00:00.000Z"));
    await store.save(session("bbbbbb", "2026-11-04T10:00:00.000Z"));
    const list = await store.list();
    expect(list.map((l) => l.id)).toEqual(["bbbbbb", "aaaaaa"]);
    expect(list[0]).toMatchObject({ state: "ok", updatedAt: "2026-11-04T10:00:00.000Z", summary: '@me.bsky.social · 1 thread, 2 posts · "Launch day"' });
  });
  it("lists a bad file as unreadable, and can delete it", async () => {
    await store.save(session("aaaaaa"));
    writeFileSync(path("bbbbbb"), "{ not json");
    writeFileSync(path("cccccc"), JSON.stringify({ ...good(), version: 9 }));
    const list = await store.list();
    expect(list.filter((l) => l.state === "unreadable").map((l) => l.id).sort()).toEqual(["bbbbbb", "cccccc"]);
    await store.delete(id("bbbbbb"));
    expect(existsSync(path("bbbbbb"))).toBe(false);
  });
  it("won't load a bad file", async () => {
    await store.save(session("aaaaaa"));
    writeFileSync(path("aaaaaa"), JSON.stringify({ ...good(), id: "aaaaaa", did: "nope" }));
    await expect(store.load(id("aaaaaa"))).rejects.toThrow("Session file: bad did");
  });
  it("has nothing to list before anything is saved", async () => {
    await expect(store.list()).resolves.toEqual([]);
  });
  it("locks a session against a second REPL, and shows it as in use", async () => {
    await store.save(session("aaaaaa"));
    await expect(store.lock(id("aaaaaa"))).resolves.toBe(true);
    expect(readFileSync(path("aaaaaa", "lock"), "utf-8")).toBe(String(process.pid));
    await expect(store.lock(id("aaaaaa"))).resolves.toBe(false);
    await expect(store.list()).resolves.toMatchObject([{ state: "in use" }]);
    await store.unlock(id("aaaaaa"));
    await expect(store.lock(id("aaaaaa"))).resolves.toBe(true);
  });
  it("clears a lock whose process has died", async () => {
    await store.save(session("aaaaaa"));
    writeFileSync(path("aaaaaa", "lock"), String(spawnSync("true").pid));
    await expect(store.list()).resolves.toMatchObject([{ state: "ok" }]);
    await expect(store.lock(id("aaaaaa"))).resolves.toBe(true);
  });
  it("treats an empty lock as a REPL still starting, then as stale", async () => {
    await store.save(session("aaaaaa"));
    writeFileSync(path("aaaaaa", "lock"), "");
    await expect(store.lock(id("aaaaaa"))).resolves.toBe(false);
    const old = new Date(Date.now() - 60_000);
    utimesSync(path("aaaaaa", "lock"), old, old);
    await expect(store.list()).resolves.toMatchObject([{ state: "ok" }]);
    await expect(store.lock(id("aaaaaa"))).resolves.toBe(true);
  });
  it("only ever lets one REPL have a session", async () => {
    await store.save(session("aaaaaa"));
    const results = await Promise.all([store.lock(id("aaaaaa")), store.lock(id("aaaaaa")), new SessionStore(join(dir, "repl", "sessions")).lock(id("aaaaaa"))]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it("doesn't touch locks when listing, so it can't take one from a REPL that's starting", async () => {
    await store.save(session("aaaaaa"));
    writeFileSync(path("aaaaaa", "lock"), String(spawnSync("true").pid));
    await store.list();
    expect(existsSync(path("aaaaaa", "lock"))).toBe(true);
  });
  it("lets go of the lock if it can't write the PID", async () => {
    await store.save(session("aaaaaa"));
    const realOpen = vi.mocked(open).getMockImplementation()!;
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const file = await realOpen(...args);
      file.writeFile = async () => {
        throw new Error("ENOSPC");
      };
      return file;
    });
    await expect(store.lock(id("aaaaaa"))).rejects.toThrow("ENOSPC");
    expect(existsSync(path("aaaaaa", "lock"))).toBe(false);
  });
  it("carries on saving after a save fails", async () => {
    await store.save(session("aaaaaa"));
    vi.mocked(rename).mockRejectedValueOnce(new Error("ENOSPC"));
    await expect(store.save({ ...session("aaaaaa"), history: ["lost"] })).rejects.toThrow("ENOSPC");
    await store.save({ ...session("aaaaaa"), history: ["kept"] });
    expect((await store.load(id("aaaaaa"))).history).toEqual(["kept"]);
  });
  it("doesn't call a broken folder empty", async () => {
    await store.save(session("aaaaaa"));
    chmodSync(join(dir, "repl", "sessions"), 0o000);
    await expect(store.list()).rejects.toThrow();
    chmodSync(join(dir, "repl", "sessions"), 0o700);
  });
  it("never prunes a file it can't read, which only you should delete", async () => {
    await store.save(session("aaaaaa"));
    writeFileSync(path("bbbbbb"), "{ not json");
    writeFileSync(path("cccccc"), JSON.stringify({ ...good(), version: 9 }));
    await store.prune(1);
    expect(existsSync(path("bbbbbb"))).toBe(true);
    expect(existsSync(path("cccccc"))).toBe(true);
  });
  it("never prunes a session with unsent posts", async () => {
    await store.save(session("aaaaaa", "2026-11-01T10:00:00.000Z"));
    await store.save({ ...session("bbbbbb", "2026-11-02T10:00:00.000Z"), pending: [] });
    await store.save({ ...session("cccccc", "2026-11-03T10:00:00.000Z"), pending: [] });
    await store.prune(1);
    expect((await store.list()).map((l) => l.id).sort()).toEqual(["aaaaaa", "cccccc"]);
  });
  it("clears up after a crash: temp files and locks with no session", async () => {
    await store.save(session("aaaaaa"));
    const dead = spawnSync("true").pid;
    writeFileSync(path(`aaaaaa.${dead}`, "tmp"), "{ half");
    writeFileSync(path("bbbbbb", "lock"), String(dead));
    writeFileSync(path(`aaaaaa.${process.pid}`, "tmp"), "{ ours");
    await store.prune(10);
    expect(readdirSync(join(dir, "repl", "sessions")).sort()).toEqual([`aaaaaa.${process.pid}.tmp`, "aaaaaa.json"]);
  });
  it("prunes the oldest, but never one in use", async () => {
    const quiet = (s: string, at: string) => ({ ...session(s, at), pending: [] });
    await store.save(quiet("aaaaaa", "2026-11-01T10:00:00.000Z"));
    await store.save(quiet("bbbbbb", "2026-11-02T10:00:00.000Z"));
    await store.save(quiet("cccccc", "2026-11-03T10:00:00.000Z"));
    await store.lock(id("aaaaaa"));
    await store.prune(1);
    expect((await store.list()).map((l) => l.id).sort()).toEqual(["aaaaaa", "cccccc"]);
  });
});

describe("resolveId", () => {
  const listing = (id: string, state: SessionListing["state"] = "ok"): SessionListing => ({ id, state, summary: "", updatedAt: "2026-11-04T10:00:00.000Z" });
  const list = [listing("k3f7xq"), listing("k3a2bc"), listing("p2m2wd")];
  it("takes last, an id or a unique prefix", () => {
    expect(resolveId("last", list)).toBe("k3f7xq");
    expect(resolveId("p2m2wd", list)).toBe("p2m2wd");
    expect(resolveId("k3f", list)).toBe("k3f7xq");
  });
  it("skips sessions it can't open when asked for the last one", () => {
    expect(resolveId("last", [listing("k3f7xq", "unreadable"), listing("k3a2bc", "in use"), listing("p2m2wd")])).toBe("p2m2wd");
  });
  it("says when a prefix is ambiguous, or nothing matches", () => {
    expect(() => resolveId("k3", list)).toThrow('"k3" could be k3f7xq or k3a2bc');
    expect(() => resolveId("zz", list)).toThrow('No saved session "zz"');
    expect(() => resolveId("last", [])).toThrow("No saved sessions");
    expect(() => resolveId("last", [listing("k3f7xq", "in use")])).toThrow("No saved session is free to resume");
  });
});
