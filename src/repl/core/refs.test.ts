import { describe, it, expect, vi } from "vitest";
import { Registry, resolveRef, type PostLookup, type RefAgent } from "./refs";
import type { AtUri, Cid, Did, StrongRef } from "./types";

const self = "did:plc:me" as Did;
const alice = "did:plc:alice" as Did;
const ref = (did: Did, rkey: string): StrongRef => ({
  uri: `at://${did}/app.bsky.feed.post/${rkey}` as AtUri,
  cid: `bafy${rkey}` as Cid,
});
const r1 = ref(self, "3lbx7kt5def2a");
const r2 = ref(self, "3lbx7kt5def2b");
const r3 = ref(self, "3lbx7kt5def2c");
const ext = ref(alice, "3lbx7kt5def2x");

function agent(posts: PostLookup[] = []): RefAgent & { getPosts: ReturnType<typeof vi.fn> } {
  return {
    selfDid: self,
    resolveHandle: vi.fn(async (h: string) => (h === "alice.bsky.social" ? alice : self)),
    getPosts: vi.fn(async (uris: AtUri[]) => posts.filter((p) => uris.includes(p.uri))),
  };
}
const aliceRoot = ref(alice, "3lbx7kt5def2r");
const alicePost: PostLookup = {
  ...ext,
  authorDid: alice,
  authorHandle: "alice.bsky.social",
  text: "Lexicons are the API contract",
  root: ext,
};

describe("Registry numbering", () => {
  it("numbers everything session-wide by default", () => {
    const reg = new Registry(false);
    expect(reg.addOwn(r1, { root: r1, text: "one" }).label).toBe("1");
    expect(reg.addExternal(alicePost, {}).label).toBe("2");
    expect(reg.addOwn(r2, { root: r1, parent: r1.uri, text: "two" }).label).toBe("3");
  });
  it("letters each thread in prefixed mode, with A0 for an external thread start", () => {
    const reg = new Registry(true);
    const a = reg.newLetter();
    expect(reg.addOwn(r1, { root: r1, text: "one", letter: a }).label).toBe("A1");
    expect(reg.addOwn(r2, { root: r1, parent: r1.uri, text: "two", letter: a }).label).toBe("A2");
    const b = reg.newLetter();
    expect(reg.addExternal(alicePost, { letter: b, startsThread: true }).label).toBe("B0");
    expect(reg.addOwn(r3, { root: ext, parent: ext.uri, text: "reply", letter: b }).label).toBe("B1");
  });
  it("goes from Z to AA", () => {
    const reg = new Registry(true);
    for (let i = 0; i < 26; i++) reg.newLetter();
    expect(reg.newLetter()).toBe("AA");
  });
  it("keeps a first-line excerpt of 40 graphemes", () => {
    const reg = new Registry(false);
    expect(reg.addOwn(r1, { root: r1, text: `${"x".repeat(45)}\nsecond line` }).excerpt).toBe(`${"x".repeat(40)}…`);
  });
});

describe("resolveRef", () => {
  it("finds own labels without the network", async () => {
    const reg = new Registry(false);
    reg.addOwn(r1, { root: r1, text: "one" });
    const a = agent();
    await expect(resolveRef("1", { registry: reg, agent: a })).resolves.toMatchObject({ ref: r1, root: r1 });
    expect(a.getPosts).not.toHaveBeenCalled();
  });
  it("resolves a bare number within the current letter in prefixed mode", async () => {
    const reg = new Registry(true);
    const a = reg.newLetter();
    reg.addOwn(r1, { root: r1, text: "one", letter: a });
    const b = reg.newLetter();
    reg.addOwn(r2, { root: r2, text: "two", letter: b });
    await expect(resolveRef("1", { registry: reg, agent: agent(), letter: a })).resolves.toMatchObject({ ref: r1 });
    await expect(resolveRef("1", { registry: reg, agent: agent() })).resolves.toMatchObject({ ref: r2 });
    await expect(resolveRef("a1", { registry: reg, agent: agent() })).resolves.toMatchObject({ ref: r1 });
  });
  it.each([
    [`at://alice.bsky.social/app.bsky.feed.post/3lbx7kt5def2x`],
    [`at://${alice}/app.bsky.feed.post/3lbx7kt5def2x`],
    ["https://bsky.app/profile/alice.bsky.social/post/3lbx7kt5def2x"],
    [`https://bsky.app/profile/${alice}/post/3lbx7kt5def2x`],
  ])("fetches %s once and takes its thread root", async (input) => {
    const a = agent([alicePost]);
    await expect(resolveRef(input, { registry: new Registry(false), agent: a })).resolves.toMatchObject({
      ref: ext,
      root: ext,
      post: alicePost,
    });
    expect(a.getPosts).toHaveBeenCalledOnce();
  });
  it("treats a bare TID as a post in your own repo", async () => {
    const mine: PostLookup = { ...r3, authorDid: self, authorHandle: "me.bsky.social", text: "hi" };
    await expect(resolveRef("3lbx7kt5def2c", { registry: new Registry(false), agent: agent([mine]) })).resolves.toMatchObject({
      ref: r3,
    });
  });
  it.each([
    ["nonsense", `Can't resolve "nonsense": use a number, #n, rkey, at:// URI or bsky.app link`],
    ["9", "No post (9) in this session"],
    ["#2", "No post #2 in this session"],
  ])("rejects %s", async (input, message) => {
    await expect(resolveRef(input, { registry: new Registry(false), agent: agent() })).rejects.toThrow(message);
  });
  it("points at -l for a prefixed label in session-wide mode", async () => {
    await expect(resolveRef("A3", { registry: new Registry(false), agent: agent() })).rejects.toThrow(
      '"A3" is a prefixed label; start the REPL with -l to use them',
    );
  });
  it("says when a post can't be found", async () => {
    await expect(
      resolveRef("3lbx7kt5def2c", { registry: new Registry(false), agent: agent() }),
    ).rejects.toThrow("Post not found");
  });
});

describe("Registry.format", () => {
  it("prints the label and rkey, the URI when verbose, and where a post branches from", () => {
    const reg = new Registry(false);
    const one = reg.addOwn(r1, { root: r1, text: "one" });
    const two = reg.addOwn(r2, { root: r1, parent: r1.uri, text: "two" });
    const three = reg.addOwn(r3, { root: r1, parent: r1.uri, text: "three" });
    expect(reg.format(one, false)).toBe("(1) 3lbx7kt5def2a");
    expect(reg.format(two, false)).toBe("(2) 3lbx7kt5def2b");
    expect(reg.format(three, false)).toBe("(3) 3lbx7kt5def2c ↳ 1");
    expect(reg.format(one, true)).toBe(`(1) 3lbx7kt5def2a (${r1.uri})`);
  });
  it("marks external posts with their author", () => {
    const reg = new Registry(false);
    expect(reg.format(reg.addExternal(alicePost, {}), false)).toBe("(1) 3lbx7kt5def2x ext @alice.bsky.social");
    const yours = new Registry(false, alice);
    expect(yours.format(yours.addExternal(alicePost, {}), false)).toBe("(1) 3lbx7kt5def2x");
  });
});

describe("viewed posts", () => {
  it("get a label each, once", () => {
    const reg = new Registry(false);
    expect(reg.addViewed(ext).label).toBe("#1");
    expect(reg.addViewed(r1).label).toBe("#2");
    expect(reg.addViewed(ext).label).toBe("#1");
    expect(reg.viewed("#2")?.uri).toBe(r1.uri);
    expect(reg.viewed("#9")).toBeUndefined();
  });
  it("resolve through the network, as they could be anyone's", async () => {
    const reg = new Registry(false);
    reg.addViewed(ext);
    const a = agent([alicePost]);
    const r = await resolveRef("#1", { registry: reg, agent: a });
    expect(r.ref).toEqual(ext);
    expect(a.getPosts).toHaveBeenCalledWith([ext.uri]);
  });
  it("resolve without the network if they're already known", async () => {
    const reg = new Registry(false);
    reg.addOwn(r1, { root: r1, text: "a" });
    reg.addViewed(r1);
    const a = agent();
    await expect(resolveRef("#1", { registry: reg, agent: a })).resolves.toMatchObject({ ref: r1 });
    expect(a.getPosts).not.toHaveBeenCalled();
  });
  it("come back from a snapshot, and numbering carries on", () => {
    const reg = new Registry(false);
    reg.addViewed(ext);
    const { posts, viewed, nextLabel, nextLetter, nextViewed } = reg.snapshot();
    const back = new Registry(false);
    back.restore(posts, { nextLabel, nextLetter, nextViewed }, viewed);
    expect(back.viewed("#1")?.uri).toBe(ext.uri);
    expect(back.addViewed(r1).label).toBe("#2");
    expect(back.addViewed(ext).label).toBe("#1");
  });
});

describe("a saved registry", () => {
  it("carries on numbering where it stopped", () => {
    const reg = new Registry(false);
    reg.addOwn(r1, { root: r1, text: "a" });
    reg.addOwn(r2, { root: r1, text: "b" });
    const { posts, nextLabel, nextLetter } = reg.snapshot();
    const back = new Registry(false);
    back.restore(posts, { nextLabel, nextLetter, nextViewed: 1 });
    expect(back.byLabel("2")?.uri).toBe(r2.uri);
    expect(back.addOwn(r3, { root: r1, text: "c" }).label).toBe("3");
  });
  it("carries on each thread's letter", () => {
    const reg = new Registry(true);
    const a = reg.newLetter();
    reg.addOwn(r1, { root: r1, text: "a", letter: a });
    reg.addOwn(r2, { root: r1, text: "b", letter: a });
    const { posts, nextLabel, nextLetter } = reg.snapshot();
    const back = new Registry(true);
    back.restore(posts, { nextLabel, nextLetter, nextViewed: 1 });
    expect(back.currentLetter()).toBe("A");
    expect(back.addOwn(r3, { root: r1, text: "c", letter: "A" }).label).toBe("A3");
    expect(back.newLetter()).toBe("B");
  });
});

describe("Registry.format notes", () => {
  it("shows what a post carried", () => {
    const reg = new Registry(false);
    const own = (r: StrongRef, notes?: string) => reg.format(reg.addOwn(r, { root: r, text: "a", notes }), false);
    expect(own(r1, "📷 2")).toBe("(1) 3lbx7kt5def2a 📷 2");
    expect(own(r2, "🎞")).toBe("(2) 3lbx7kt5def2b 🎞");
    expect(own(r3, "❝ 1")).toBe("(3) 3lbx7kt5def2c ❝ 1");
  });
});

describe("an external reply", () => {
  const reply: PostLookup = { ...alicePost, root: aliceRoot, parent: aliceRoot };
  it("keeps its own thread's root, so a reply to it stays in that thread", async () => {
    const r = await resolveRef(ext.uri, { registry: new Registry(false), agent: agent([reply]) });
    expect(r.ref).toEqual(ext);
    expect(r.root).toEqual(aliceRoot);
    expect(new Registry(false).addExternal(reply, {}).root).toEqual(aliceRoot);
  });
});

describe("recentLabels", () => {
  it("lists your posts, then what you've read, newest first", () => {
    const reg = new Registry(false, self);
    const [a, b] = [ref(self, "3lbx7kt5aaa2a"), ref(self, "3lbx7kt5aaa2b")];
    reg.addOwn(a, { root: a, text: "one" });
    reg.addOwn(b, { root: a, parent: a.uri, text: "two" });
    reg.addViewed(ref(alice, "3lbx7kt5aaa2c"));
    reg.addViewed(ref(alice, "3lbx7kt5aaa2d"));
    expect(reg.recentLabels()).toEqual(["2", "1", "#2", "#1"]);
  });
  it("leaves out what you've deleted", () => {
    const reg = new Registry(false, self);
    const a = ref(self, "3lbx7kt5aaa2a");
    reg.addOwn(a, { root: a, text: "one" });
    reg.markDeleted(a.uri);
    expect(reg.recentLabels()).toEqual([]);
  });
});

describe("a deleted post", () => {
  it("says so wherever it's listed", () => {
    const reg = new Registry(false, self);
    const a = ref(self, "3lbx7kt5aaa2a");
    const entry = reg.addOwn(a, { root: a, text: "one" });
    reg.markDeleted(a.uri);
    expect(reg.format(entry, false)).toBe("(1) 3lbx7kt5aaa2a deleted");
  });
});

describe("a session saved before #n labels existed", () => {
  it("starts them at #1, not #0", () => {
    const reg = new Registry(false, self);
    reg.restore([], { nextLabel: 1, nextViewed: 0, nextLetter: 0 });
    expect(reg.addViewed(ref(alice, "3lbx7kt5aaa2c")).label).toBe("#1");
  });
});

describe("a link copied with something on the end", () => {
  it.each(["?ref_src=embed", "#x", "/?ref_src=embed", "/"])("still resolves: %s", async (tail) => {
    const uri = `at://${alice}/app.bsky.feed.post/3lbx7kt5aaa2c` as AtUri;
    const agent = { resolveHandle: vi.fn(), getPosts: vi.fn(async () => [{ uri, cid: "bafyabc" as Cid, authorDid: alice, authorHandle: "alice.test", text: "" }]) };
    const resolved = await resolveRef(`https://bsky.app/profile/${alice}/post/3lbx7kt5aaa2c${tail}`, { registry: new Registry(false, self), agent: agent as never });
    expect(resolved.ref.uri).toBe(uri);
  });
});
