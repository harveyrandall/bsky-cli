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

import { registerThread } from "@/commands/thread";
import { isJson } from "@/index";
import { printPost, outputJson } from "@/lib/format";

function makeProgram(register: (cmd: Command) => void): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

function makePostView(text: string) {
  return {
    uri: `at://did:plc:test/app.bsky.feed.post/${text}`,
    author: { handle: "user.bsky.social", displayName: "User" },
    record: {
      $type: "app.bsky.feed.post",
      text,
      createdAt: "2025-01-01T00:00:00Z",
    },
    likeCount: 0,
    repostCount: 0,
    replyCount: 0,
  };
}

describe("thread command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isJson as any).mockReturnValue(false);
  });

  it("normalizeUri prepends at://did:plc: when needed", async () => {
    const postView = makePostView("main");

    mockAgent.getPostThread.mockResolvedValue({
      data: {
        thread: {
          post: postView,
          replies: [],
        },
      },
    });

    const program = makeProgram(registerThread);
    await program.parseAsync(["thread", "abc123/app.bsky.feed.post/xyz"], {
      from: "user",
    });

    expect(mockAgent.getPostThread).toHaveBeenCalledWith(
      expect.objectContaining({
        uri: "at://did:plc:abc123/app.bsky.feed.post/xyz",
      }),
    );
  });

  it("displays post and replies", async () => {
    const postView = makePostView("main post");
    const replyView = makePostView("reply post");

    mockAgent.getPostThread.mockResolvedValue({
      data: {
        thread: {
          post: postView,
          replies: [{ post: replyView }],
        },
      },
    });

    const program = makeProgram(registerThread);
    await program.parseAsync(
      ["thread", "at://did:plc:abc/app.bsky.feed.post/123"],
      { from: "user" },
    );

    expect(printPost).toHaveBeenCalledTimes(2);
    expect((printPost as any).mock.calls[0][0]).toBe(postView);
    expect((printPost as any).mock.calls[1][0]).toBe(replyView);
  });

  it("in JSON mode outputs thread and replies", async () => {
    (isJson as any).mockReturnValue(true);

    const postView = makePostView("main post");
    const replyView = makePostView("reply post");

    const thread = {
      post: postView,
      replies: [{ post: replyView }],
    };

    mockAgent.getPostThread.mockResolvedValue({
      data: { thread },
    });

    const program = makeProgram(registerThread);
    await program.parseAsync(
      ["thread", "at://did:plc:abc/app.bsky.feed.post/123"],
      { from: "user" },
    );

    expect(outputJson).toHaveBeenCalledTimes(2);
    // First call: the thread itself
    expect((outputJson as any).mock.calls[0][0]).toBe(thread);
    // Second call: the reply
    expect((outputJson as any).mock.calls[1][0]).toEqual({ post: replyView });
    expect(printPost).not.toHaveBeenCalled();
  });
});
