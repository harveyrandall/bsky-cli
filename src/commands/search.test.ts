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

import { registerSearch, registerSearchUsers } from "@/commands/search";
import { isJson } from "@/index";
import { printPost, outputJson } from "@/lib/format";

function makeProgram(register: (cmd: Command) => void): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

function makePostView(text: string, createdAt: string) {
  return {
    uri: `at://did:plc:test/app.bsky.feed.post/${text}`,
    author: { handle: "user.bsky.social", displayName: "User" },
    record: {
      $type: "app.bsky.feed.post",
      text,
      createdAt,
    },
    likeCount: 0,
    repostCount: 0,
    replyCount: 0,
  };
}

describe("search command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isJson as any).mockReturnValue(false);
  });

  it("paginates through results", async () => {
    const post1 = makePostView("first", "2025-01-01T00:00:00Z");
    const post2 = makePostView("second", "2025-01-02T00:00:00Z");

    mockAgent.app.bsky.feed.searchPosts
      .mockResolvedValueOnce({
        data: {
          posts: [post1],
          cursor: "page2",
        },
      })
      .mockResolvedValueOnce({
        data: {
          posts: [post2],
          cursor: undefined,
        },
      });

    const program = makeProgram(registerSearch);
    await program.parseAsync(["search", "hello", "world"], { from: "user" });

    expect(mockAgent.app.bsky.feed.searchPosts).toHaveBeenCalledWith(
      expect.objectContaining({ q: "hello world" }),
    );
    // Should have been called twice due to pagination
    expect(mockAgent.app.bsky.feed.searchPosts).toHaveBeenCalledTimes(2);
  });

  it("sorts results by date ascending", async () => {
    const older = makePostView("older", "2025-01-01T00:00:00Z");
    const newer = makePostView("newer", "2025-01-02T00:00:00Z");

    mockAgent.app.bsky.feed.searchPosts.mockResolvedValue({
      data: {
        posts: [newer, older],
        cursor: undefined,
      },
    });

    const program = makeProgram(registerSearch);
    await program.parseAsync(["search", "test"], { from: "user" });

    expect(printPost).toHaveBeenCalledTimes(2);
    // Sorted ascending: older first
    expect((printPost as any).mock.calls[0][0]).toBe(older);
    expect((printPost as any).mock.calls[1][0]).toBe(newer);
  });
});

describe("search-users command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isJson as any).mockReturnValue(false);
  });

  it("calls searchActors and outputs each actor", async () => {
    const actors = [
      { handle: "alice.bsky.social", displayName: "Alice" },
      { handle: "bob.bsky.social", displayName: "Bob" },
    ];

    mockAgent.searchActors.mockResolvedValue({
      data: { actors },
    });

    const program = makeProgram(registerSearchUsers);
    await program.parseAsync(["search-users", "alice"], { from: "user" });

    expect(mockAgent.searchActors).toHaveBeenCalledWith({
      term: "alice",
      limit: 100,
    });

    expect(outputJson).toHaveBeenCalledTimes(2);
    expect((outputJson as any).mock.calls[0][0]).toBe(actors[0]);
    expect((outputJson as any).mock.calls[1][0]).toBe(actors[1]);
  });
});
