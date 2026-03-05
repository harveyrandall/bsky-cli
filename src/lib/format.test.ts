import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { printPost, printActor, formatTime, outputJson } from "./format";

describe("outputJson", () => {
  it("outputs JSON string to console", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    outputJson({ foo: "bar" });
    expect(spy).toHaveBeenCalledWith('{"foo":"bar"}');
    spy.mockRestore();
  });
});

describe("formatTime", () => {
  it("converts date string to ISO format", () => {
    const result = formatTime("2024-01-15T12:00:00Z");
    expect(result).toBe("2024-01-15T12:00:00.000Z");
  });
});

describe("printPost", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    logSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it("prints post author, text, and URI", () => {
    const post = {
      uri: "at://did:plc:test/app.bsky.feed.post/abc",
      cid: "cid123",
      author: { did: "did:plc:test", handle: "alice.bsky.social", displayName: "Alice" },
      record: { text: "Hello world", createdAt: "2024-01-15T12:00:00Z" },
      indexedAt: "2024-01-15T12:00:00Z",
      likeCount: 5,
      repostCount: 2,
      replyCount: 1,
    };
    printPost(post as any);
    const allOutput = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(allOutput).toContain("Hello world");
  });
});

describe("printActor", () => {
  it("prints handle and DID", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    printActor({ handle: "alice.bsky.social", displayName: "Alice", did: "did:plc:test" });
    const allOutput = [...writeSpy.mock.calls, ...logSpy.mock.calls].flat().join("");
    expect(allOutput).toContain("alice.bsky.social");
    expect(allOutput).toContain("did:plc:test");
    writeSpy.mockRestore();
    logSpy.mockRestore();
  });
});
