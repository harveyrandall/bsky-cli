import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MARKERS } from "./markers";
import { SessionStore, parseSessionFile, type ReplSessionFile } from "./persist";
import { Repl, type ReplAsk, type ReplSettings } from "./repl";
import { SessionKeeper } from "./session";
import type { AtUri, Cid, Did, IsoUtc, SessionId, StrongRef } from "./types";

const did = "did:plc:me" as Did;
const id = "k3f7xq" as SessionId;
const meta = { id, createdAt: "2026-11-04T09:00:00.000Z" as IsoUtc, handle: "me.bsky.social" as const, did };
const ref = (n: number): StrongRef => ({
  uri: `at://${did}/app.bsky.feed.post/3lbx7kt5def${String.fromCharCode(97 + n)}a` as AtUri,
  cid: `bafy${String.fromCharCode(97 + n)}` as Cid,
});
const draft = (text: string) => ({ text, cursor: text.length, history: [] });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bsky-session-"));
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-04T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

/** A real session, store and keeper over a temp folder. */
function session(o: { settings?: Partial<ReplSettings>; resume?: ReplSessionFile; choose?: ReplAsk["choose"]; store?: SessionStore } = {}) {
  let n = 0;
  const posted: string[] = [];
  const store = o.store ?? new SessionStore(dir);
  const agent = {
    selfDid: did,
    resolveHandle: vi.fn(async () => did),
    getPosts: vi.fn(async (uris: AtUri[]) => uris.map((uri) => ({ uri, cid: "bafya" as Cid, authorDid: did, authorHandle: "me.bsky.social" as const, text: "" }))),
    post: vi.fn(async (text: string) => {
      posted.push(text);
      return ref(++n);
    }),
  };
  const keeper = new SessionKeeper(store, meta, 50, o.resume);
  let repl: Repl | undefined = undefined;
  const made: Repl = new Repl(
    { autoThread: false, prefixThread: false, threadLabel: false, undo: 0, pace: 0, askToSave: false, verbose: false, forceAlt: false, ...o.settings },
    DEFAULT_MARKERS,
    {
      agent,
      ask: {
        cooldown: async () => 0,
        saveOffer: async () => "no",
        confirm: async () => true,
        alt: async () => undefined,
        choose: o.choose ?? (async () => undefined),
        text: async () => undefined,
      },
      print: () => {},
      // As the App does: every change saves.
      onChange: () => void (repl && keeper.save(repl).catch(() => {})),
      restore: () => {},
      composerBusy: () => false,
      saveDraft: async () => ({ id: "d1" }),
      deleteDraft: async () => {},
      saveConfig: async () => {},
      saveScheduled: async () => ({ id: "s1" }),
      schedulerRunning: () => true,
      fs: { size: async () => 10, head: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
    },
  );
  repl = made;
  const flush = () => vi.advanceTimersByTimeAsync(0);
  return { repl: made, keeper, store, agent, posted, flush };
}
const onDisk = () => parseSessionFile(JSON.parse(readFileSync(join(dir, `${id}.json`), "utf-8")));
const saved = () => existsSync(join(dir, `${id}.json`));

describe("SessionKeeper", () => {
  it("writes nothing while there's nothing to come back to", async () => {
    const { repl, keeper } = session();
    await keeper.save(repl);
    expect(readdirSync(dir)).toEqual([]);
  });
  it("locks the session with its first save", async () => {
    const { repl, keeper, flush } = session();
    await repl.post("one");
    await flush();
    await keeper.save(repl);
    expect(readdirSync(dir).sort()).toEqual([`${id}.json`, `${id}.lock`]);
  });
  it("saves a composer that's been cleared, once there's a file", async () => {
    const { repl, keeper } = session();
    keeper.track(draft("hello"));
    await keeper.save(repl);
    expect(onDisk().composer.text).toBe("hello");
    keeper.track(draft(""));
    await keeper.save(repl);
    expect(onDisk().composer.text).toBe("");
  });
  it("saves in the order it was asked to, even around the first lock", async () => {
    const { repl, keeper } = session();
    keeper.track(draft("one"));
    const first = keeper.save(repl);
    keeper.track(draft("two"));
    await Promise.all([first, keeper.save(repl)]);
    expect(onDisk().composer.text).toBe("two");
  });
});

describe("leaving", () => {
  it("clears what you dealt with at the prompt, keeps the posts and says how to come back", async () => {
    const { repl, keeper, flush } = session();
    await repl.post("one");
    await flush();
    await repl.attach(["/x/a.png"]);
    keeper.track(draft("thrown away"));
    await keeper.save(repl);
    const end = await keeper.end(repl, true);
    expect(end).toEqual({ resumable: true });
    expect(onDisk()).toMatchObject({ composer: { text: "", cursor: 0 }, staged: [], pending: [] });
    expect(onDisk().posts).toHaveLength(1);
    expect(existsSync(join(dir, `${id}.lock`))).toBe(false);
  });
  it("deletes a session with nothing in it", async () => {
    const { repl, keeper } = session();
    keeper.track(draft("thrown away"));
    await keeper.save(repl);
    expect(await keeper.end(repl, true)).toEqual({ resumable: false });
    expect(readdirSync(dir)).toEqual([]);
  });
  it("writes nothing more once it's begun, whatever changes", async () => {
    const { repl, keeper } = session();
    keeper.track(draft("thrown away"));
    await keeper.save(repl);
    await keeper.end(repl, true);
    keeper.track(draft("too late"));
    await keeper.save(repl);
    repl.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(readdirSync(dir)).toEqual([]);
  });
  it("waits for a post already going, so it's in the file", async () => {
    const { repl, keeper, agent, flush } = session();
    let finish = (_: StrongRef) => {};
    agent.post.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await repl.post("going");
    await flush();
    const ending = keeper.end(repl, true);
    await flush();
    finish(ref(1));
    expect(await ending).toEqual({ resumable: true });
    expect(onDisk()).toMatchObject({ pending: [], posts: [{ label: "1" }] });
  });
  it("doesn't wait for ever for a post that never lands, and keeps it to ask about", async () => {
    const { repl, keeper, agent, flush } = session();
    agent.post.mockImplementationOnce(() => new Promise(() => {}));
    await repl.post("going");
    await flush();
    const ending = keeper.end(repl, true);
    await vi.advanceTimersByTimeAsync(5000);
    await ending;
    expect(onDisk().pending.map((p) => p.posts[0])).toEqual(["going"]);
  });
});

describe("stopping any other way", () => {
  it("keeps what's queued, what's staged and the latest text, and doesn't send", async () => {
    const { repl, keeper, posted, flush } = session({ settings: { undo: 5 } });
    await repl.attach(["/x/a.png"]);
    await repl.post("waiting");
    await repl.attach(["/x/b.png"]);
    keeper.track(draft("typed a moment ago"));
    expect(await keeper.end(repl, false)).toEqual({ resumable: true });
    expect(onDisk()).toMatchObject({ composer: { text: "typed a moment ago" }, staged: [{ path: "/x/b.png" }] });
    expect(onDisk().pending.map((p) => p.posts[0])).toEqual(["waiting"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(posted).toEqual([]);
  });
  it("snapshots before the queue closes, and writes after", async () => {
    const { repl, keeper } = session({ settings: { undo: 5 } });
    await repl.post("waiting");
    const close = vi.spyOn(repl, "close");
    const snapshot = vi.spyOn(repl, "snapshot");
    await keeper.end(repl, false);
    expect(snapshot.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
  });
});

describe("when the disk fails", () => {
  const failing = (fail: Partial<Record<"save" | "prune" | "delete", Error>>) => {
    const store = new SessionStore(dir);
    for (const [name, err] of Object.entries(fail)) vi.spyOn(store, name as "save").mockRejectedValue(err);
    return store;
  };
  it("says why a final save failed, and still lets the session go", async () => {
    const store = failing({ save: new Error("ENOSPC") });
    const unlock = vi.spyOn(store, "unlock");
    const prune = vi.spyOn(store, "prune");
    const { repl, keeper, flush } = session({ store });
    await repl.post("one");
    await flush();
    expect(await keeper.end(repl, true)).toEqual({ resumable: false, error: "ENOSPC" });
    expect(unlock).toHaveBeenCalled();
    expect(prune).toHaveBeenCalled();
  });
  it("doesn't let a failed prune take the hint away from a good session", async () => {
    const { repl, keeper, flush } = session({ store: failing({ prune: new Error("EPERM") }) });
    await repl.post("one");
    await flush();
    expect(await keeper.end(repl, true)).toEqual({ resumable: true });
  });
});

describe("a round trip through the disk", () => {
  it("carries on where it stopped", async () => {
    const first = session();
    await first.repl.startThread("one");
    await first.flush();
    await first.repl.submitText("two");
    await first.flush();
    first.keeper.track(draft("half a thought"));
    await first.keeper.save(first.repl);

    const file = await new SessionStore(dir).load(id);
    const second = session({ resume: file });
    await second.repl.resume(file);
    await second.flush();
    expect(second.repl.prompt()).toBe("thread (2) ›");
    expect(second.repl.thread()?.cursor).toEqual(ref(2));
    await second.keeper.save(second.repl);
    expect(onDisk().composer.text).toBe("half a thought");
  });
  it("still asks about unsent posts after a second kill at the question", async () => {
    const first = session({ settings: { undo: 5 } });
    await first.repl.post("waiting");
    await first.keeper.save(first.repl);

    const file = await new SessionStore(dir).load(id);
    const second = session({ resume: file, settings: { undo: 5 }, choose: () => new Promise(() => {}) });
    void second.repl.resume(file);
    await second.flush();
    await second.keeper.save(second.repl);
    expect(onDisk().pending.map((p) => p.posts[0])).toEqual(["waiting"]);
  });
});
