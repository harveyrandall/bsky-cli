import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { createMockAgent } from "@/test-utils";

const mockAgent = createMockAgent();

vi.mock("@/index", () => ({
  getClient: vi.fn(() => Promise.resolve(mockAgent)),
  isJson: vi.fn(() => false),
}));

vi.mock("@/lib/format", () => ({
  printActor: vi.fn(),
  outputJson: vi.fn(),
}));

import {
  registerFollow,
  registerUnfollow,
  registerFollows,
  registerFollowers,
  registerBlock,
  registerUnblock,
  registerBlocks,
  registerMute,
} from "./social";
import { isJson } from "@/index";
import { printActor, outputJson } from "@/lib/format";

function makeProgram(register: (cmd: Command) => void): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

describe("social commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish default return values after clearAllMocks
    (isJson as any).mockReturnValue(false);
  });

  describe("follow", () => {
    it("calls getProfile then agent.follow with the DID", async () => {
      mockAgent.getProfile.mockResolvedValue({
        data: { did: "did:plc:alice" },
      });
      mockAgent.follow.mockResolvedValue({
        uri: "at://did:plc:test123/app.bsky.graph.follow/abc",
      });

      const program = makeProgram(registerFollow);
      await program.parseAsync(["follow", "alice.bsky.social"], { from: "user" });

      expect(mockAgent.getProfile).toHaveBeenCalledWith({ actor: "alice.bsky.social" });
      expect(mockAgent.follow).toHaveBeenCalledWith("did:plc:alice");
    });

    it("follows multiple handles", async () => {
      mockAgent.getProfile
        .mockResolvedValueOnce({ data: { did: "did:plc:alice" } })
        .mockResolvedValueOnce({ data: { did: "did:plc:bob" } });
      mockAgent.follow
        .mockResolvedValueOnce({ uri: "at://did:plc:test123/app.bsky.graph.follow/a" })
        .mockResolvedValueOnce({ uri: "at://did:plc:test123/app.bsky.graph.follow/b" });

      const program = makeProgram(registerFollow);
      await program.parseAsync(["follow", "alice.bsky.social", "bob.bsky.social"], { from: "user" });

      expect(mockAgent.follow).toHaveBeenCalledTimes(2);
      expect(mockAgent.follow).toHaveBeenCalledWith("did:plc:alice");
      expect(mockAgent.follow).toHaveBeenCalledWith("did:plc:bob");
    });
  });

  describe("unfollow", () => {
    it("gets profile, finds viewer.following URI, calls deleteRecord", async () => {
      const followUri = "at://did:plc:test123/app.bsky.graph.follow/rkey123";
      mockAgent.getProfile.mockResolvedValue({
        data: { did: "did:plc:alice", viewer: { following: followUri } },
      });

      const program = makeProgram(registerUnfollow);
      await program.parseAsync(["unfollow", "alice.bsky.social"], { from: "user" });

      expect(mockAgent.getProfile).toHaveBeenCalledWith({ actor: "alice.bsky.social" });
      expect(mockAgent.com.atproto.repo.deleteRecord).toHaveBeenCalledWith({
        repo: "did:plc:test123",
        collection: "app.bsky.graph.follow",
        rkey: "rkey123",
      });
    });

    it("skips when viewer.following is absent", async () => {
      mockAgent.getProfile.mockResolvedValue({
        data: { did: "did:plc:alice", viewer: {} },
      });

      const program = makeProgram(registerUnfollow);
      await program.parseAsync(["unfollow", "alice.bsky.social"], { from: "user" });

      expect(mockAgent.com.atproto.repo.deleteRecord).not.toHaveBeenCalled();
    });
  });

  describe("follows", () => {
    it("paginates through follows and prints actors", async () => {
      const actor1 = { did: "did:plc:a", handle: "a.bsky.social" };
      const actor2 = { did: "did:plc:b", handle: "b.bsky.social" };

      mockAgent.getFollows
        .mockResolvedValueOnce({
          data: { follows: [actor1], cursor: "page2" },
        })
        .mockResolvedValueOnce({
          data: { follows: [actor2], cursor: undefined },
        });

      const program = makeProgram(registerFollows);
      await program.parseAsync(["follows"], { from: "user" });

      expect(mockAgent.getFollows).toHaveBeenCalledTimes(2);
      expect(mockAgent.getFollows).toHaveBeenCalledWith({
        actor: "test.bsky.social",
        cursor: undefined,
        limit: 100,
      });
      expect(mockAgent.getFollows).toHaveBeenCalledWith({
        actor: "test.bsky.social",
        cursor: "page2",
        limit: 100,
      });
      expect(printActor).toHaveBeenCalledTimes(2);
      expect(printActor).toHaveBeenCalledWith(actor1);
      expect(printActor).toHaveBeenCalledWith(actor2);
    });

    it("uses --handle option when provided", async () => {
      mockAgent.getFollows.mockResolvedValue({
        data: { follows: [], cursor: undefined },
      });

      const program = makeProgram(registerFollows);
      await program.parseAsync(["follows", "--handle", "other.bsky.social"], { from: "user" });

      expect(mockAgent.getFollows).toHaveBeenCalledWith({
        actor: "other.bsky.social",
        cursor: undefined,
        limit: 100,
      });
    });

    it("outputs JSON when isJson is true", async () => {
      (isJson as any).mockReturnValue(true);
      const actor = { did: "did:plc:a", handle: "a.bsky.social" };
      mockAgent.getFollows.mockResolvedValue({
        data: { follows: [actor], cursor: undefined },
      });

      const program = makeProgram(registerFollows);
      await program.parseAsync(["follows"], { from: "user" });

      expect(outputJson).toHaveBeenCalledWith(actor);
      expect(printActor).not.toHaveBeenCalled();
    });
  });

  describe("followers", () => {
    it("paginates through followers and prints actors", async () => {
      const actor1 = { did: "did:plc:a", handle: "a.bsky.social" };

      mockAgent.getFollowers.mockResolvedValue({
        data: { followers: [actor1], cursor: undefined },
      });

      const program = makeProgram(registerFollowers);
      await program.parseAsync(["followers"], { from: "user" });

      expect(mockAgent.getFollowers).toHaveBeenCalledWith({
        actor: "test.bsky.social",
        cursor: undefined,
        limit: 100,
      });
      expect(printActor).toHaveBeenCalledWith(actor1);
    });
  });

  describe("block", () => {
    it("resolves handle to DID via getProfile, then calls createRecord", async () => {
      mockAgent.getProfile.mockResolvedValue({
        data: { did: "did:plc:badactor" },
      });
      mockAgent.com.atproto.repo.createRecord.mockResolvedValue({
        data: { uri: "at://did:plc:test123/app.bsky.graph.block/xyz" },
      });

      const program = makeProgram(registerBlock);
      await program.parseAsync(["block", "badactor.bsky.social"], { from: "user" });

      expect(mockAgent.getProfile).toHaveBeenCalledWith({ actor: "badactor.bsky.social" });
      expect(mockAgent.com.atproto.repo.createRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          repo: "did:plc:test123",
          collection: "app.bsky.graph.block",
          record: expect.objectContaining({
            $type: "app.bsky.graph.block",
            subject: "did:plc:badactor",
          }),
        }),
      );
    });

    it("skips getProfile when input is already a DID", async () => {
      mockAgent.com.atproto.repo.createRecord.mockResolvedValue({
        data: { uri: "at://did:plc:test123/app.bsky.graph.block/xyz" },
      });

      const program = makeProgram(registerBlock);
      await program.parseAsync(["block", "did:plc:directdid"], { from: "user" });

      expect(mockAgent.getProfile).not.toHaveBeenCalled();
      expect(mockAgent.com.atproto.repo.createRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          record: expect.objectContaining({
            subject: "did:plc:directdid",
          }),
        }),
      );
    });
  });

  describe("unblock", () => {
    it("gets profile, finds viewer.blocking URI, calls deleteRecord", async () => {
      const blockUri = "at://did:plc:test123/app.bsky.graph.block/rkey456";
      mockAgent.getProfile.mockResolvedValue({
        data: { did: "did:plc:badactor", viewer: { blocking: blockUri } },
      });

      const program = makeProgram(registerUnblock);
      await program.parseAsync(["unblock", "badactor.bsky.social"], { from: "user" });

      expect(mockAgent.com.atproto.repo.deleteRecord).toHaveBeenCalledWith({
        repo: "did:plc:test123",
        collection: "app.bsky.graph.block",
        rkey: "rkey456",
      });
    });

    it("skips when viewer.blocking is absent", async () => {
      mockAgent.getProfile.mockResolvedValue({
        data: { did: "did:plc:badactor", viewer: {} },
      });

      const program = makeProgram(registerUnblock);
      await program.parseAsync(["unblock", "badactor.bsky.social"], { from: "user" });

      expect(mockAgent.com.atproto.repo.deleteRecord).not.toHaveBeenCalled();
    });
  });

  describe("blocks", () => {
    it("paginates through blocks and prints actors", async () => {
      const block1 = { did: "did:plc:blocked1", handle: "blocked.bsky.social" };

      mockAgent.app.bsky.graph.getBlocks.mockResolvedValue({
        data: { blocks: [block1], cursor: undefined },
      });

      const program = makeProgram(registerBlocks);
      await program.parseAsync(["blocks"], { from: "user" });

      expect(mockAgent.app.bsky.graph.getBlocks).toHaveBeenCalledWith({
        cursor: undefined,
        limit: 100,
      });
      expect(printActor).toHaveBeenCalledWith(block1);
    });
  });

  describe("mute", () => {
    it("resolves handle to DID then calls agent.mute", async () => {
      mockAgent.getProfile.mockResolvedValue({
        data: { did: "did:plc:annoying" },
      });

      const program = makeProgram(registerMute);
      await program.parseAsync(["mute", "annoying.bsky.social"], { from: "user" });

      expect(mockAgent.getProfile).toHaveBeenCalledWith({ actor: "annoying.bsky.social" });
      expect(mockAgent.mute).toHaveBeenCalledWith("did:plc:annoying");
    });

    it("skips getProfile when input is already a DID", async () => {
      const program = makeProgram(registerMute);
      await program.parseAsync(["mute", "did:plc:directmute"], { from: "user" });

      expect(mockAgent.getProfile).not.toHaveBeenCalled();
      expect(mockAgent.mute).toHaveBeenCalledWith("did:plc:directmute");
    });
  });
});
