import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { createMockAgent } from "@/test-utils";

const mockAgent = createMockAgent();

vi.mock("@/index", () => ({
  getClient: vi.fn(() => Promise.resolve(mockAgent)),
  isJson: vi.fn(() => false),
}));

vi.mock("@/lib/format", () => ({
  printPost: vi.fn(),
  outputJson: vi.fn(),
}));

// Mock AppBskyFeedDefs.isPostView to return true
vi.mock("@atproto/api", () => ({
  AppBskyFeedDefs: {
    isPostView: vi.fn(() => true),
  },
}));

import { registerBookmarks } from "./bookmark";
import { isJson } from "@/index";
import { printPost, outputJson } from "@/lib/format";

function createProgram() {
  const program = new Command();
  program.exitOverride(); // prevent process.exit
  registerBookmarks(program);
  return program;
}

describe("bookmarks create", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a bookmark", async () => {
    mockAgent.com.atproto.repo.getRecord.mockResolvedValue({
      data: { uri: "at://did:plc:abc/app.bsky.feed.post/123", cid: "cid456" },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "bookmarks", "create", "at://did:plc:abc/app.bsky.feed.post/123"]);

    expect(mockAgent.app.bsky.bookmark.createBookmark).toHaveBeenCalledWith({
      uri: "at://did:plc:abc/app.bsky.feed.post/123",
      cid: "cid456",
    });
    logSpy.mockRestore();
  });
});

describe("bookmarks delete", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes a bookmark", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "bookmarks", "delete", "at://did:plc:abc/app.bsky.feed.post/123"]);

    expect(mockAgent.app.bsky.bookmark.deleteBookmark).toHaveBeenCalledWith({
      uri: "at://did:plc:abc/app.bsky.feed.post/123",
    });
    logSpy.mockRestore();
  });
});

describe("bookmarks get", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists bookmarks and calls printPost for PostView items", async () => {
    mockAgent.app.bsky.bookmark.getBookmarks.mockResolvedValue({
      data: {
        bookmarks: [
          { item: { uri: "at://test", cid: "cid", author: {}, record: {}, indexedAt: "" }, subject: {}, createdAt: "" },
        ],
        cursor: undefined,
      },
    });

    const program = createProgram();
    await program.parseAsync(["node", "test", "bookmarks", "get"]);

    expect(mockAgent.app.bsky.bookmark.getBookmarks).toHaveBeenCalled();
    expect(printPost).toHaveBeenCalled();
  });

  it("outputs JSON when --json flag is set", async () => {
    (isJson as any).mockReturnValue(true);
    mockAgent.app.bsky.bookmark.getBookmarks.mockResolvedValue({
      data: {
        bookmarks: [{ item: {}, subject: {}, createdAt: "" }],
        cursor: undefined,
      },
    });

    const program = createProgram();
    await program.parseAsync(["node", "test", "bookmarks", "get"]);

    expect(outputJson).toHaveBeenCalled();
  });
});
