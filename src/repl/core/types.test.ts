import { describe, it, expect } from "vitest";
import { isAtUri, isCid, isCooldown, isDid, isHandle, isOwnLabel, isRkey, rkeyOf, toStrongRef } from "./types";

const uri = "at://did:plc:abc123/app.bsky.feed.post/3lbx7kt5def2v";
const cid = "bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

describe("guards", () => {
  it.each([
    [isDid, "did:plc:abc123", true],
    [isDid, "did:web:example.com", true],
    [isDid, "did:key:z6Mk", false],
    [isDid, "alice.bsky.social", false],
    [isHandle, "alice.bsky.social", true],
    [isHandle, "alice", false],
    [isRkey, "3lbx7kt5def2v", true],
    [isRkey, "self", false],
    [isAtUri, uri, true],
    [isAtUri, "at://did:plc:abc123/app.bsky.feed.like/3lbx7kt5def2v", false],
    [isAtUri, "at://alice.bsky.social/app.bsky.feed.post/3lbx7kt5def2v", false],
    [isAtUri, "at://did:plc:abc123/app.bsky.feed.post/self", false],
    [isAtUri, `${uri}?x=1`, false],
    [isAtUri, `${uri}#frag`, false],
    [isAtUri, `${uri}/extra`, false],
    [isAtUri, "AT://did:plc:abc123/app.bsky.feed.post/3lbx7kt5def2v", false],
    [isAtUri, "at://did:plc:abc123//app.bsky.feed.post/3lbx7kt5def2v", false],
    [isCid, cid, true],
    [isCid, "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", false],
    [isOwnLabel, "4", true],
    [isOwnLabel, "A4", true],
    [isOwnLabel, "AA3", true],
    [isOwnLabel, "ZZZ999", true],
    [isOwnLabel, "a3", false],
    [isOwnLabel, "#3", false],
    [isOwnLabel, "AAAA1", false],
    [isCooldown, 0, true],
    [isCooldown, 15, true],
    [isCooldown, 7, false],
    [isCooldown, "5", false],
  ] as const)("%o(%o) → %o", (guard, value, expected) => {
    expect((guard as (v: unknown) => boolean)(value)).toBe(expected);
  });
  it.each([isDid, isHandle, isRkey, isAtUri, isCid, isOwnLabel])("%o rejects non-strings", (guard) => {
    expect(guard(5)).toBe(false);
    expect(guard(undefined)).toBe(false);
  });
});

describe("toStrongRef", () => {
  it("accepts a post reference", () => {
    expect(toStrongRef({ uri, cid })).toEqual({ uri, cid });
  });
  it("throws on anything else", () => {
    expect(() => toStrongRef({ uri: "x", cid: "y" })).toThrow("Unexpected post reference from the server");
  });
});

describe("rkeyOf", () => {
  it("returns the record key", () => {
    expect(rkeyOf(uri as never)).toBe("3lbx7kt5def2v");
  });
});
