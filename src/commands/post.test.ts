import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { createMockAgent } from "@/test-utils";
import { registerPost, registerReply, registerQuote } from "@/commands/post";

const mockAgent = createMockAgent();

vi.mock("@/index", () => ({
  getClient: vi.fn(() => Promise.resolve(mockAgent)),
  isJson: vi.fn(() => false),
}));

const mockSaveDraft = vi.fn().mockResolvedValue({ id: "1741392000000-a7f3" });
vi.mock("@/drafts", () => ({
  saveDraft: (...args: unknown[]) => mockSaveDraft(...args),
}));

// Mock node:fs/promises for file read operations
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

// Mock cheerio to prevent real HTML parsing in link card tests
vi.mock("cheerio", () => ({
  load: vi.fn(() => {
    const $ = (selector: string) => ({
      text: () => "Test Title",
      attr: (name: string) =>
        name === "content" ? "Test Description" : undefined,
    });
    return $;
  }),
}));

// Mock global fetch to prevent real network requests (used by fetchLinkCard)
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("post command", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockAgent.post.mockResolvedValue({
      uri: "at://did:plc:test123/app.bsky.feed.post/abc",
      cid: "bafyreicid-abc",
    });

    // Default: fetch returns a non-ok response so link card is skipped
    mockFetch.mockResolvedValue({ ok: false });
  });

  it("creates a basic text post with joined text parts", async () => {
    const program = new Command();
    program.option("--json", "Output as JSON");
    registerPost(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["node", "test", "post", "Hello", "world"]);

    expect(mockAgent.post).toHaveBeenCalledTimes(1);
    const record = mockAgent.post.mock.calls[0][0];
    expect(record.text).toBe("Hello world");
    expect(record.$type).toBe("app.bsky.feed.post");
    expect(record.createdAt).toBeDefined();

    expect(consoleSpy).toHaveBeenCalledWith(
      "at://did:plc:test123/app.bsky.feed.post/abc",
    );

    consoleSpy.mockRestore();
  });

  it("uploads an image with correct JPEG mime type and attaches embed", async () => {
    const { readFile } = await import("node:fs/promises");
    const mockReadFile = vi.mocked(readFile);

    // JPEG magic bytes: 0xFF 0xD8
    const jpegBuffer = Buffer.from([0xff, 0xd8, 0x00, 0x00, 0x00]);
    mockReadFile.mockResolvedValue(jpegBuffer);

    mockAgent.uploadBlob.mockResolvedValue({
      data: { blob: "blob-ref-jpeg" },
    });

    const program = new Command();
    program.option("--json", "Output as JSON");
    registerPost(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync([
      "node",
      "test",
      "post",
      "Check this photo",
      "--image",
      "/tmp/test.jpg",
    ]);

    expect(mockReadFile).toHaveBeenCalledWith("/tmp/test.jpg");
    expect(mockAgent.uploadBlob).toHaveBeenCalledWith(jpegBuffer, {
      encoding: "image/jpeg",
    });

    const record = mockAgent.post.mock.calls[0][0];
    expect(record.text).toBe("Check this photo");
    expect(record.embed).toBeDefined();
    expect(record.embed.$type).toBe("app.bsky.embed.images");
    expect(record.embed.images).toHaveLength(1);
    expect(record.embed.images[0].image).toBe("blob-ref-jpeg");

    consoleSpy.mockRestore();
  });

  it("detects PNG mime type from magic bytes", async () => {
    const { readFile } = await import("node:fs/promises");
    const mockReadFile = vi.mocked(readFile);

    // PNG magic bytes: 0x89 0x50 0x4E 0x47
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]);
    mockReadFile.mockResolvedValue(pngBuffer);

    mockAgent.uploadBlob.mockResolvedValue({
      data: { blob: "blob-ref-png" },
    });

    const program = new Command();
    program.option("--json", "Output as JSON");
    registerPost(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync([
      "node",
      "test",
      "post",
      "PNG image",
      "--image",
      "/tmp/test.png",
    ]);

    expect(mockAgent.uploadBlob).toHaveBeenCalledWith(pngBuffer, {
      encoding: "image/png",
    });

    consoleSpy.mockRestore();
  });

  it("errors when no text is provided", async () => {
    const program = new Command();
    program.option("--json", "Output as JSON");
    registerPost(program);

    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code) => {
        throw new Error(`exit ${code}`);
      });

    await expect(
      program.parseAsync(["node", "test", "post"]),
    ).rejects.toThrow("exit 1");

    expect(consoleSpy).toHaveBeenCalledWith("Error: post text is required");

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe("reply command", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockAgent.post.mockResolvedValue({
      uri: "at://did:plc:test123/app.bsky.feed.post/reply789",
      cid: "bafyreicid-reply789",
    });

    mockFetch.mockResolvedValue({ ok: false });
  });

  it("fetches parent post and creates a reply with root and parent refs", async () => {
    // Parent is a top-level post (no reply field), so root = parent
    mockAgent.com.atproto.repo.getRecord.mockResolvedValue({
      data: {
        uri: "at://did:plc:abc/app.bsky.feed.post/123",
        cid: "bafyreicid-parent",
        value: {
          $type: "app.bsky.feed.post",
          text: "Original post",
          createdAt: "2025-01-01T00:00:00Z",
        },
      },
    });

    const program = new Command();
    program.option("--json", "Output as JSON");
    registerReply(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync([
      "node",
      "test",
      "reply",
      "at://did:plc:abc/app.bsky.feed.post/123",
      "My",
      "reply",
    ]);

    expect(mockAgent.com.atproto.repo.getRecord).toHaveBeenCalledWith({
      repo: "did:plc:abc",
      collection: "app.bsky.feed.post",
      rkey: "123",
    });

    expect(mockAgent.post).toHaveBeenCalledTimes(1);
    const record = mockAgent.post.mock.calls[0][0];
    expect(record.text).toBe("My reply");
    expect(record.$type).toBe("app.bsky.feed.post");
    expect(record.reply).toEqual({
      root: {
        uri: "at://did:plc:abc/app.bsky.feed.post/123",
        cid: "bafyreicid-parent",
      },
      parent: {
        uri: "at://did:plc:abc/app.bsky.feed.post/123",
        cid: "bafyreicid-parent",
      },
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      "at://did:plc:test123/app.bsky.feed.post/reply789",
    );

    consoleSpy.mockRestore();
  });

  it("uses the original root when replying to a reply", async () => {
    // Parent is itself a reply, so it has a reply.root pointing to the original post
    mockAgent.com.atproto.repo.getRecord.mockResolvedValue({
      data: {
        uri: "at://did:plc:abc/app.bsky.feed.post/456",
        cid: "bafyreicid-child",
        value: {
          $type: "app.bsky.feed.post",
          text: "A reply",
          createdAt: "2025-01-01T00:00:00Z",
          reply: {
            root: {
              uri: "at://did:plc:abc/app.bsky.feed.post/001",
              cid: "bafyreicid-root",
            },
            parent: {
              uri: "at://did:plc:abc/app.bsky.feed.post/001",
              cid: "bafyreicid-root",
            },
          },
        },
      },
    });

    const program = new Command();
    program.option("--json", "Output as JSON");
    registerReply(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync([
      "node",
      "test",
      "reply",
      "at://did:plc:abc/app.bsky.feed.post/456",
      "Nested",
      "reply",
    ]);

    const record = mockAgent.post.mock.calls[0][0];
    expect(record.reply).toEqual({
      root: {
        uri: "at://did:plc:abc/app.bsky.feed.post/001",
        cid: "bafyreicid-root",
      },
      parent: {
        uri: "at://did:plc:abc/app.bsky.feed.post/456",
        cid: "bafyreicid-child",
      },
    });

    consoleSpy.mockRestore();
  });
});

describe("quote command", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockAgent.post.mockResolvedValue({
      uri: "at://did:plc:test123/app.bsky.feed.post/quote999",
      cid: "bafyreicid-quote999",
    });

    mockFetch.mockResolvedValue({ ok: false });
  });

  it("fetches the quoted post and creates a post with record embed", async () => {
    mockAgent.com.atproto.repo.getRecord.mockResolvedValue({
      data: {
        uri: "at://did:plc:abc/app.bsky.feed.post/123",
        cid: "bafyreicid-quoted",
        value: {
          $type: "app.bsky.feed.post",
          text: "Quoted post",
          createdAt: "2025-01-01T00:00:00Z",
        },
      },
    });

    const program = new Command();
    program.option("--json", "Output as JSON");
    registerQuote(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync([
      "node",
      "test",
      "quote",
      "at://did:plc:abc/app.bsky.feed.post/123",
      "My",
      "quote",
    ]);

    expect(mockAgent.com.atproto.repo.getRecord).toHaveBeenCalledWith({
      repo: "did:plc:abc",
      collection: "app.bsky.feed.post",
      rkey: "123",
    });

    expect(mockAgent.post).toHaveBeenCalledTimes(1);
    const record = mockAgent.post.mock.calls[0][0];
    expect(record.text).toBe("My quote");
    expect(record.$type).toBe("app.bsky.feed.post");
    expect(record.embed).toEqual({
      $type: "app.bsky.embed.record",
      record: {
        uri: "at://did:plc:abc/app.bsky.feed.post/123",
        cid: "bafyreicid-quoted",
      },
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      "at://did:plc:test123/app.bsky.feed.post/quote999",
    );

    consoleSpy.mockRestore();
  });
});

describe("post --draft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: false });
  });

  it("saves draft instead of publishing when --draft is used", async () => {
    const program = new Command();
    program.option("--json", "Output as JSON");
    program.option("-p, --profile <name>");
    registerPost(program);

    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await program.parseAsync(["node", "test", "post", "Draft post", "--draft"]);

    expect(mockSaveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "post",
        text: "Draft post",
        reason: "manual",
      }),
      undefined,
    );
    expect(mockAgent.post).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith("Draft saved: 1741392000000-a7f3");

    consoleSpy.mockRestore();
  });

  it("auto-saves as draft on grapheme length error", async () => {
    mockAgent.post.mockRejectedValue(
      new Error("record/text must not be longer than 300 graphemes"),
    );

    const program = new Command();
    program.option("--json", "Output as JSON");
    program.option("-p, --profile <name>");
    registerPost(program);

    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code) => {
        throw new Error(`exit ${code}`);
      });

    await expect(
      program.parseAsync(["node", "test", "post", "A very long post"]),
    ).rejects.toThrow("exit 1");

    expect(mockSaveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "length" }),
      undefined,
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Post exceeds character limit"),
    );

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("auto-saves as draft on network error", async () => {
    const networkErr = new TypeError("fetch failed");
    networkErr.cause = new Error("ECONNREFUSED");
    mockAgent.post.mockRejectedValue(networkErr);

    const program = new Command();
    program.option("--json", "Output as JSON");
    program.option("-p, --profile <name>");
    registerPost(program);

    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code) => {
        throw new Error(`exit ${code}`);
      });

    await expect(
      program.parseAsync(["node", "test", "post", "Offline post"]),
    ).rejects.toThrow("exit 1");

    expect(mockSaveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "network" }),
      undefined,
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Network error"),
    );

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("re-throws non-draft errors", async () => {
    mockAgent.post.mockRejectedValue(new Error("InternalServerError"));

    const program = new Command();
    program.option("--json", "Output as JSON");
    program.option("-p, --profile <name>");
    registerPost(program);

    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      program.parseAsync(["node", "test", "post", "Test"]),
    ).rejects.toThrow("InternalServerError");

    expect(mockSaveDraft).not.toHaveBeenCalled();
  });

  it("reply --draft stores replyUri without calling API", async () => {
    const program = new Command();
    program.option("--json", "Output as JSON");
    program.option("-p, --profile <name>");
    registerReply(program);

    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await program.parseAsync([
      "node",
      "test",
      "reply",
      "at://did:plc:abc/app.bsky.feed.post/123",
      "Draft reply",
      "--draft",
    ]);

    expect(mockSaveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "reply",
        text: "Draft reply",
        replyUri: "at://did:plc:abc/app.bsky.feed.post/123",
        reason: "manual",
      }),
      undefined,
    );
    expect(mockAgent.post).not.toHaveBeenCalled();
    expect(mockAgent.com.atproto.repo.getRecord).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("quote --draft stores quoteUri without calling API", async () => {
    const program = new Command();
    program.option("--json", "Output as JSON");
    program.option("-p, --profile <name>");
    registerQuote(program);

    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await program.parseAsync([
      "node",
      "test",
      "quote",
      "at://did:plc:abc/app.bsky.feed.post/123",
      "Draft quote",
      "--draft",
    ]);

    expect(mockSaveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "quote",
        text: "Draft quote",
        quoteUri: "at://did:plc:abc/app.bsky.feed.post/123",
        reason: "manual",
      }),
      undefined,
    );
    expect(mockAgent.post).not.toHaveBeenCalled();
    expect(mockAgent.com.atproto.repo.getRecord).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});
