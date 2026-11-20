import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { createMockAgent } from "@/test-utils";
import { registerLike, registerUnlike, registerLikes, unlikePost } from "@/commands/like";

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

    // What the PDS sends when it deleted something. With nothing there, it leaves `commit` out.
    mockAgent.com.atproto.repo.deleteRecord.mockResolvedValue({ data: { commit: { cid: "bafycommit", rev: "rev1" } } });
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

  it("prints each like it removed", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerUnlike(program);

    await program.parseAsync(["node", "test", "unlike", "at://did:plc:test123/app.bsky.feed.like/456"]);

    expect(logSpy.mock.calls).toEqual([["at://did:plc:test123/app.bsky.feed.like/456"]]);
    logSpy.mockRestore();
  });

  it("prints nothing for a like it couldn't remove", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockAgent.com.atproto.repo.deleteRecord.mockRejectedValue(new Error("offline"));
    const program = new Command();
    registerUnlike(program);

    await expect(
      program.parseAsync(["node", "test", "unlike", "at://did:plc:test123/app.bsky.feed.like/456"]),
    ).rejects.toThrow("offline");

    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("refuses another account's like", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const program = new Command();
    registerUnlike(program);

    try {
      await program.parseAsync(["node", "test", "unlike", "at://did:plc:abc/app.bsky.feed.like/456"]);

      expect(errSpy).toHaveBeenCalledWith("That isn't yours: at://did:plc:abc/app.bsky.feed.like/456");
      expect(mockAgent.com.atproto.repo.deleteRecord).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = undefined;
      errSpy.mockRestore();
    }
  });

  it("says when there was no like to remove, printing no URI", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockAgent.com.atproto.repo.deleteRecord.mockResolvedValueOnce({ data: {} });
    const program = new Command();
    registerUnlike(program);

    try {
      await program.parseAsync(["node", "test", "unlike", "at://did:plc:test123/app.bsky.feed.like/456"]);

      expect(logSpy).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledWith("Nothing to delete: at://did:plc:test123/app.bsky.feed.like/456");
      expect(process.exitCode).toBeUndefined();
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("refuses anything but a like, so a post's URI doesn't delete the post", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerUnlike(program);

    try {
      await program.parseAsync([
        "node", "test", "unlike",
        "at://did:plc:test123/app.bsky.feed.post/456",
        "at://did:plc:test123/app.bsky.feed.like/789",
      ]);

      expect(errSpy).toHaveBeenCalledWith("unlike takes a like's URI, not app.bsky.feed.post: at://did:plc:test123/app.bsky.feed.post/456");
      expect(mockAgent.com.atproto.repo.deleteRecord).toHaveBeenCalledTimes(1);
      expect(mockAgent.com.atproto.repo.deleteRecord).toHaveBeenCalledWith(expect.objectContaining({ collection: "app.bsky.feed.like", rkey: "789" }));
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = undefined;
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
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

describe("unlikePost", () => {
  it("says if the post has gone, rather than that it wasn't liked", async () => {
    const agent = { getPosts: vi.fn(async () => ({ data: { posts: [] } })), deleteLike: vi.fn() };
    await expect(unlikePost(agent as never, "at://post")).rejects.toThrow("Post not found");
  });
  const client = (viewer: object) => ({ getPosts: vi.fn(async () => ({ data: { posts: [{ viewer }] } })), deleteLike: vi.fn(async () => {}) });
  it("deletes your like of a post, from what the post says it is", async () => {
    const agent = client({ like: "at://me/like/1" });
    await expect(unlikePost(agent as never, "at://post")).resolves.toBe(true);
    expect(agent.deleteLike).toHaveBeenCalledWith("at://me/like/1");
  });
  it("says so if you hadn't liked it", async () => {
    const agent = client({});
    await expect(unlikePost(agent as never, "at://post")).resolves.toBe(false);
    expect(agent.deleteLike).not.toHaveBeenCalled();
  });
});
