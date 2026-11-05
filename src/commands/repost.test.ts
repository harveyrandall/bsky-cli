import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { createMockAgent } from "@/test-utils";
import {
  registerRepost,
  registerRemoveRepost,
  registerReposts, unrepostPost
} from "@/commands/repost";

const mockAgent = createMockAgent();

vi.mock("@/index", () => ({
  getClient: vi.fn(() => Promise.resolve(mockAgent)),
  isJson: vi.fn(() => false),
}));

describe("repost command", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockAgent.com.atproto.repo.getRecord.mockResolvedValue({
      data: {
        uri: "at://did:plc:abc/app.bsky.feed.post/123",
        cid: "bafyreicid123",
      },
    });

    mockAgent.repost.mockResolvedValue({
      uri: "at://did:plc:test123/app.bsky.feed.repost/789",
    });
  });

  it("calls getRecord then agent.repost with correct URI and CID", async () => {
    const program = new Command();
    program.option("--json", "Output as JSON");
    registerRepost(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync([
      "node",
      "test",
      "repost",
      "at://did:plc:abc/app.bsky.feed.post/123",
    ]);

    expect(mockAgent.com.atproto.repo.getRecord).toHaveBeenCalledWith({
      repo: "did:plc:abc",
      collection: "app.bsky.feed.post",
      rkey: "123",
    });

    expect(mockAgent.repost).toHaveBeenCalledWith(
      "at://did:plc:abc/app.bsky.feed.post/123",
      "bafyreicid123",
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      "at://did:plc:test123/app.bsky.feed.repost/789",
    );

    consoleSpy.mockRestore();
  });
});

describe("remove-repost command", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockAgent.com.atproto.repo.deleteRecord.mockResolvedValue({});
  });

  it("calls deleteRecord with correct repo, collection, and rkey", async () => {
    const program = new Command();
    program.option("--json", "Output as JSON");
    registerRemoveRepost(program);

    await program.parseAsync([
      "node",
      "test",
      "remove-repost",
      "at://did:plc:test123/app.bsky.feed.repost/789",
    ]);

    expect(mockAgent.com.atproto.repo.deleteRecord).toHaveBeenCalledWith({
      repo: "did:plc:test123",
      collection: "app.bsky.feed.repost",
      rkey: "789",
    });
  });

  it("handles multiple URIs", async () => {
    const program = new Command();
    program.option("--json", "Output as JSON");
    registerRemoveRepost(program);

    await program.parseAsync([
      "node",
      "test",
      "remove-repost",
      "at://did:plc:test123/app.bsky.feed.repost/789",
      "at://did:plc:test123/app.bsky.feed.repost/101",
    ]);

    expect(mockAgent.com.atproto.repo.deleteRecord).toHaveBeenCalledTimes(2);
  });
});

describe("reposts command", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockAgent.com.atproto.repo.getRecord.mockResolvedValue({
      data: {
        uri: "at://did:plc:abc/app.bsky.feed.post/123",
        cid: "bafyreicid123",
      },
    });

    mockAgent.getRepostedBy.mockResolvedValue({
      data: {
        repostedBy: [
          { handle: "bob.bsky.social", displayName: "Bob" },
        ],
      },
    });
  });

  it("calls getRepostedBy and outputs results", async () => {
    const program = new Command();
    program.option("--json", "Output as JSON");
    registerReposts(program);

    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync([
      "node",
      "test",
      "reposts",
      "at://did:plc:abc/app.bsky.feed.post/123",
    ]);

    expect(mockAgent.com.atproto.repo.getRecord).toHaveBeenCalledWith({
      repo: "did:plc:abc",
      collection: "app.bsky.feed.post",
      rkey: "123",
    });

    expect(mockAgent.getRepostedBy).toHaveBeenCalledWith({
      uri: "at://did:plc:abc/app.bsky.feed.post/123",
      cid: "bafyreicid123",
      limit: 50,
    });

    const writtenOutput = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(writtenOutput).toContain("bob.bsky.social");

    stdoutSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});

describe("unrepostPost", () => {
  const client = (posts: object[]) => ({ getPosts: vi.fn(async () => ({ data: { posts } })), deleteRepost: vi.fn(async () => {}) });
  it("deletes your repost of a post, from what the post says it is", async () => {
    const agent = client([{ viewer: { repost: "at://me/repost/1" } }]);
    await expect(unrepostPost(agent as never, "at://post")).resolves.toBe(true);
    expect(agent.deleteRepost).toHaveBeenCalledWith("at://me/repost/1");
  });
  it("says so if you hadn't reposted it, or the post has gone", async () => {
    await expect(unrepostPost(client([{ viewer: {} }]) as never, "at://post")).resolves.toBe(false);
    await expect(unrepostPost(client([]) as never, "at://post")).resolves.toBe(false);
  });
});
