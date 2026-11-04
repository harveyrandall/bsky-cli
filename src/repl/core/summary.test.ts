import { describe, it, expect } from "vitest";
import { exitSummary } from "./summary";
import { Registry } from "./refs";
import type { AtUri, Cid, Did, StrongRef } from "./types";

const me = "did:plc:me" as Did;
const ref = (c: string): StrongRef => ({ uri: `at://${me}/app.bsky.feed.post/3lbx7kt5def${c}a` as AtUri, cid: `bafy${c}` as Cid });

function sample() {
  const reg = new Registry(false);
  reg.addOwn(ref("a"), { root: ref("a"), text: "Launch day! Here's what we built" });
  reg.addOwn(ref("b"), { root: ref("a"), parent: ref("a").uri, text: "second" });
  reg.addOwn(ref("c"), { root: ref("c"), text: "an aside" });
  return reg;
}
const times = { startedAt: new Date("2026-11-04T10:00:00Z"), endedAt: new Date("2026-11-04T10:12:05Z") };

describe("exitSummary", () => {
  it("counts posts, threads and standalone posts", () => {
    expect(exitSummary({ registry: sample(), failures: [], verbose: false, handle: "me.bsky.social", ...times })).toEqual([
      "3 posts in 1 thread, 1 standalone",
    ]);
  });
  it("says when nothing was posted", () => {
    expect(exitSummary({ registry: new Registry(false), failures: [], verbose: false, handle: "me.bsky.social", ...times })).toEqual([
      "No posts this session",
    ]);
  });
  it("lists every post with its URI when verbose", () => {
    const lines = exitSummary({ registry: sample(), failures: [], verbose: true, handle: "me.bsky.social", ...times });
    expect(lines[0]).toBe("3 posts in 1 thread, 1 standalone");
    expect(lines).toContain("Session 2026-11-04T10:00:00.000Z – 2026-11-04T10:12:05.000Z (12m 5s) as @me.bsky.social");
    expect(lines).toContain("Thread (1):");
    expect(lines).toContain(`  (2) 3lbx7kt5defba (${ref("b").uri}) "second"`);
    expect(lines).toContain("Standalone:");
  });
});
