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
    ["#2", "#n labels are for viewed posts, which aren't available yet"],
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
  });
});
