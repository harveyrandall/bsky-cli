import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { printPost, printActor, formatTime, outputJson, setPostLabeler } from "./format";

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
    const allOutput = logSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
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

describe("setPostLabeler", () => {
  const post = {
    uri: "at://did:plc:a/app.bsky.feed.post/3lbx7kt5def2a",
    cid: "bafya",
    author: { handle: "alice.bsky.social", displayName: "Alice" },
    record: { text: "hello", createdAt: "2026-10-31T09:12:44.000Z" },
  } as never;
  const printed = () => {
    const out: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((text) => {
      out.push(String(text));
      return true;
    });
    const log = vi.spyOn(console, "log").mockImplementation((...args) => void out.push(args.join(" ")));
    printPost(post);
    write.mockRestore();
    log.mockRestore();
    return out;
  };
  afterEach(() => setPostLabeler(undefined));
  it("puts a label before the author", () => {
    setPostLabeler(() => "#1");
    expect(printed()[0]).toBe("#1 ");
  });
  it("leaves the output exactly as it was with no labeller, or no label", () => {
    const plain = printed();
    setPostLabeler(() => undefined);
    expect(printed()).toEqual(plain);
    expect(plain[0]).not.toContain("#");
  });
});
