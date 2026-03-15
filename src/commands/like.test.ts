import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { createMockAgent } from "@/test-utils";
import { registerLike, registerUnlike, registerLikes } from "@/commands/like";

const mockAgent = createMockAgent();

vi.mock("@/index", () => ({
  getClient: vi.fn(() => Promise.resolve(mockAgent)),
  isJson: vi.fn(() => false),
}));

describe("like command", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockAgent.com.atproto.repo.getRecord.mockResolvedValue({
      data: {
        uri: "at://did:plc:abc/app.bsky.feed.post/123",
        cid: "bafyreicid123",
      },
    });

    mockAgent.like.mockResolvedValue({
      uri: "at://did:plc:test123/app.bsky.feed.like/456",
    });
  });

  it("calls getRecord then agent.like with correct URI and CID", async () => {
    const program = new Command();
    program.option("--json", "Output as JSON");
    registerLike(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync([
      "node",
      "test",
      "like",
      "at://did:plc:abc/app.bsky.feed.post/123",
    ]);

    expect(mockAgent.com.atproto.repo.getRecord).toHaveBeenCalledWith({
      repo: "did:plc:abc",
      collection: "app.bsky.feed.post",
      rkey: "123",
    });

    expect(mockAgent.like).toHaveBeenCalledWith(
      "at://did:plc:abc/app.bsky.feed.post/123",
      "bafyreicid123",
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      "at://did:plc:test123/app.bsky.feed.like/456",
    );

    consoleSpy.mockRestore();
  });
});

describe("unlike command", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockAgent.com.atproto.repo.deleteRecord.mockResolvedValue({});
  });

  it("calls deleteRecord with correct repo, collection, and rkey", async () => {
    const program = new Command();
    program.option("--json", "Output as JSON");
    registerUnlike(program);

    await program.parseAsync([
      "node",
      "test",
      "unlike",
      "at://did:plc:test123/app.bsky.feed.like/456",
    ]);

    expect(mockAgent.com.atproto.repo.deleteRecord).toHaveBeenCalledWith({
      repo: "did:plc:test123",
      collection: "app.bsky.feed.like",
      rkey: "456",
    });
  });

  it("handles multiple URIs", async () => {
    const program = new Command();
    program.option("--json", "Output as JSON");
    registerUnlike(program);

    await program.parseAsync([
      "node",
      "test",
      "unlike",
      "at://did:plc:test123/app.bsky.feed.like/456",
      "at://did:plc:test123/app.bsky.feed.like/789",
    ]);

    expect(mockAgent.com.atproto.repo.deleteRecord).toHaveBeenCalledTimes(2);
  });
});

describe("likes command", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockAgent.com.atproto.repo.getRecord.mockResolvedValue({
      data: {
        uri: "at://did:plc:abc/app.bsky.feed.post/123",
        cid: "bafyreicid123",
      },
    });

    mockAgent.getLikes.mockResolvedValue({
      data: {
        likes: [
          {
            actor: { handle: "alice.bsky.social", displayName: "Alice" },
            createdAt: "2025-01-01T00:00:00Z",
          },
        ],
      },
    });
  });

  it("calls getLikes and outputs results", async () => {
    const program = new Command();
    program.option("--json", "Output as JSON");
    registerLikes(program);

    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync([
      "node",
      "test",
      "likes",
      "at://did:plc:abc/app.bsky.feed.post/123",
    ]);

    expect(mockAgent.com.atproto.repo.getRecord).toHaveBeenCalledWith({
      repo: "did:plc:abc",
      collection: "app.bsky.feed.post",
      rkey: "123",
    });

    expect(mockAgent.getLikes).toHaveBeenCalledWith({
      uri: "at://did:plc:abc/app.bsky.feed.post/123",
      cid: "bafyreicid123",
      limit: 50,
    });

    // Verify output contains the actor handle
    const writtenOutput = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(writtenOutput).toContain("alice.bsky.social");

    stdoutSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});
