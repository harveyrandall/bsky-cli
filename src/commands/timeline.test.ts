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

import { registerTimeline } from "@/commands/timeline";
import { isJson } from "@/index";
import { printPost, outputJson } from "@/lib/format";

function makeProgram(register: (cmd: Command) => void): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

function makeFeedItem(text: string, createdAt: string) {
  return {
    post: {
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
    },
  };
}

describe("timeline command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isJson as any).mockReturnValue(false);
  });

  it("fetches and prints posts sorted by date ascending", async () => {
    const older = makeFeedItem("older post", "2025-01-01T00:00:00Z");
    const newer = makeFeedItem("newer post", "2025-01-02T00:00:00Z");

    mockAgent.getTimeline.mockResolvedValue({
      data: {
        feed: [newer, older],
        cursor: undefined,
      },
    });

    const program = makeProgram(registerTimeline);
    await program.parseAsync(["timeline"], { from: "user" });

    expect(mockAgent.getTimeline).toHaveBeenCalled();
    expect(printPost).toHaveBeenCalledTimes(2);
    // First call should be the older post (ascending sort)
    expect((printPost as any).mock.calls[0][0]).toBe(older.post);
    expect((printPost as any).mock.calls[1][0]).toBe(newer.post);
  });

  it("with --handle uses getAuthorFeed", async () => {
    const item = makeFeedItem("alice post", "2025-01-01T00:00:00Z");

    mockAgent.getAuthorFeed.mockResolvedValue({
      data: {
        feed: [item],
        cursor: undefined,
      },
    });

    const program = makeProgram(registerTimeline);
    await program.parseAsync(["timeline", "--handle", "alice.bsky.social"], {
      from: "user",
    });

    expect(mockAgent.getAuthorFeed).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "alice.bsky.social" }),
    );
  });

  it("with --handle self uses session DID", async () => {
    const item = makeFeedItem("my post", "2025-01-01T00:00:00Z");

    mockAgent.getAuthorFeed.mockResolvedValue({
      data: {
        feed: [item],
        cursor: undefined,
      },
    });

    const program = makeProgram(registerTimeline);
    await program.parseAsync(["timeline", "--handle", "self"], {
      from: "user",
    });

    expect(mockAgent.getAuthorFeed).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "did:plc:test123" }),
    );
  });

  it("in JSON mode uses outputJson", async () => {
    (isJson as any).mockReturnValue(true);

    const item = makeFeedItem("json post", "2025-01-01T00:00:00Z");

    mockAgent.getTimeline.mockResolvedValue({
      data: {
        feed: [item],
        cursor: undefined,
      },
    });

    const program = makeProgram(registerTimeline);
    await program.parseAsync(["timeline"], { from: "user" });

    expect(outputJson).toHaveBeenCalledWith(item);
    expect(printPost).not.toHaveBeenCalled();
  });
});
