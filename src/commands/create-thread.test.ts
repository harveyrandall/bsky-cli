import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { createMockAgent } from "@/test-utils";

const mockAgent = createMockAgent();

vi.mock("@/index", () => ({
  getClient: vi.fn(() => Promise.resolve(mockAgent)),
  isJson: vi.fn(() => false),
}));

vi.mock("@/lib/format", () => ({
  outputJson: vi.fn(),
}));

const mockSaveDraft = vi.fn().mockResolvedValue({ id: "1741392000000-a7f3" });
const mockDeleteDraft = vi.fn();
vi.mock("@/drafts", () => ({
  saveDraft: (...args: unknown[]) => mockSaveDraft(...args),
  deleteDraft: (...args: unknown[]) => mockDeleteDraft(...args),
}));

// Mock node:fs/promises for file read operations
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

// Mock cheerio to prevent real HTML parsing
vi.mock("cheerio", () => ({
  load: vi.fn(() => {
    const $ = () => ({
      text: () => "Test Title",
      attr: () => undefined,
    });
    return $;
  }),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { registerCreateThread } from "./create-thread";
import { isJson } from "@/index";
import { outputJson } from "@/lib/format";

function createProgram() {
  const program = new Command();
  program.option("--json", "Output as JSON");
  program.option("-p, --profile <name>");
  program.exitOverride();
  registerCreateThread(program);
  return program;
}

describe("create-thread: single post fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgent.post.mockResolvedValue({
      uri: "at://did:plc:test/app.bsky.feed.post/single",
      cid: "bafyreicid-single",
    });
    mockFetch.mockResolvedValue({ ok: false });
  });

  it("delegates to single createPost when text <= 300 chars", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "create-thread", "Short text."]);

    expect(mockAgent.post).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      "at://did:plc:test/app.bsky.feed.post/single",
    );

    logSpy.mockRestore();
  });

  it("saves single-post draft when --draft with short text", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync([
      "node",
      "test",
      "create-thread",
      "Short text.",
      "--draft",
    ]);

    expect(mockSaveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ type: "post", text: "Short text." }),
      undefined,
    );
    expect(mockAgent.post).not.toHaveBeenCalled();

    errSpy.mockRestore();
  });
});

describe("create-thread: edge case 301-375", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: false });
  });

  it("auto-saves as draft and shows trim suggestions", async () => {
    // 320 chars with a sentence boundary near 300
    const text =
      "A".repeat(280) + ". " + "B".repeat(38);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Non-TTY so it won't prompt
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });

    const program = createProgram();
    await program.parseAsync(["node", "test", "create-thread", text, "--no-preview"]);

    expect(mockSaveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ type: "post", reason: "length" }),
      undefined,
    );
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("too long for one post"),
    );

    errSpy.mockRestore();
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalIsTTY,
      configurable: true,
    });
  });
});

describe("create-thread: thread splitting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: false });

    let callCount = 0;
    mockAgent.post.mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        uri: `at://did:plc:test/app.bsky.feed.post/t${callCount}`,
        cid: `bafyreicid-t${callCount}`,
      });
    });
  });

  it("splits long text into multiple posts and chains replies", async () => {
    // Build text > 600 chars with clear sentence boundaries
    const sentences = Array(10)
      .fill(null)
      .map((_, i) => "This is sentence number " + (i + 1) + " in the thread.");
    const text = sentences.join(" ");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync([
      "node",
      "test",
      "create-thread",
      text,
      "--no-preview",
    ]);

    // Should have multiple createPost calls
    expect(mockAgent.post.mock.calls.length).toBeGreaterThanOrEqual(2);

    // First post should have no reply ref
    const firstRecord = mockAgent.post.mock.calls[0][0];
    expect(firstRecord.reply).toBeUndefined();

    // Second post should reply to the first
    const secondRecord = mockAgent.post.mock.calls[1][0];
    expect(secondRecord.reply).toBeDefined();
    expect(secondRecord.reply.root.uri).toBe(
      "at://did:plc:test/app.bsky.feed.post/t1",
    );
    expect(secondRecord.reply.parent.uri).toBe(
      "at://did:plc:test/app.bsky.feed.post/t1",
    );

    // If 3+ posts, third should reply to second with root = first
    if (mockAgent.post.mock.calls.length >= 3) {
      const thirdRecord = mockAgent.post.mock.calls[2][0];
      expect(thirdRecord.reply.root.uri).toBe(
        "at://did:plc:test/app.bsky.feed.post/t1",
      );
      expect(thirdRecord.reply.parent.uri).toBe(
        "at://did:plc:test/app.bsky.feed.post/t2",
      );
    }

    // All URIs should be logged
    expect(logSpy.mock.calls.length).toBe(mockAgent.post.mock.calls.length);

    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("saves thread draft when --draft is used", async () => {
    const sentences = Array(10)
      .fill(null)
      .map((_, i) => "This is sentence number " + (i + 1) + " in the thread.");
    const text = sentences.join(" ");

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync([
      "node",
      "test",
      "create-thread",
      text,
      "--draft",
    ]);

    expect(mockSaveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread",
        reason: "manual",
        posts: expect.arrayContaining([
          expect.objectContaining({ text: expect.any(String) }),
        ]),
      }),
      undefined,
    );
    expect(mockAgent.post).not.toHaveBeenCalled();

    errSpy.mockRestore();
  });

  it("outputs JSON when --json flag is set", async () => {
    (isJson as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    const sentences = Array(10)
      .fill(null)
      .map((_, i) => "This is sentence number " + (i + 1) + " in the thread.");
    const text = sentences.join(" ");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync([
      "node",
      "test",
      "create-thread",
      text,
      "--no-preview",
    ]);

    expect(outputJson).toHaveBeenCalledWith(
      expect.objectContaining({
        uris: expect.arrayContaining([expect.stringContaining("at://")]),
      }),
    );

    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("adds thread labels when --thread-label is used", async () => {
    const sentences = Array(10)
      .fill(null)
      .map((_, i) => "This is sentence number " + (i + 1) + " in the thread.");
    const text = sentences.join(" ");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync([
      "node",
      "test",
      "create-thread",
      text,
      "--thread-label",
      "--no-preview",
    ]);

    // Each post text should contain 🧵 label
    for (const call of mockAgent.post.mock.calls) {
      expect(call[0].text).toContain("🧵");
    }

    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("errors when no text is provided", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code) => {
        throw new Error(`exit ${code}`);
      });

    const program = createProgram();
    await expect(
      program.parseAsync(["node", "test", "create-thread"]),
    ).rejects.toThrow("exit 1");

    expect(errSpy).toHaveBeenCalledWith("Error: thread text is required");

    errSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe("create-thread: partial failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: false });
  });

  it("saves remaining posts as draft on network error", async () => {
    let callCount = 0;
    mockAgent.post.mockImplementation(() => {
      callCount++;
      if (callCount === 2) {
        const err = new TypeError("fetch failed");
        (err as any).cause = new Error("ECONNREFUSED");
        return Promise.reject(err);
      }
      return Promise.resolve({
        uri: `at://did:plc:test/app.bsky.feed.post/t${callCount}`,
        cid: `bafyreicid-t${callCount}`,
      });
    });

    const sentences = Array(10)
      .fill(null)
      .map((_, i) => "This is sentence number " + (i + 1) + " in the thread.");
    const text = sentences.join(" ");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code) => {
        throw new Error(`exit ${code}`);
      });

    const program = createProgram();
    await expect(
      program.parseAsync(["node", "test", "create-thread", text, "--no-preview"]),
    ).rejects.toThrow("exit 1");

    // Should have saved remaining posts as draft
    expect(mockSaveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread",
        reason: "network",
        replyUri: "at://did:plc:test/app.bsky.feed.post/t1",
      }),
      undefined,
    );

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("automatically next time"),
    );

    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
