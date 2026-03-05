import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { createMockAgent } from "@/test-utils";
import { registerDelete } from "@/commands/delete";

const mockAgent = createMockAgent();

vi.mock("@/index", () => ({
  getClient: vi.fn(() => Promise.resolve(mockAgent)),
  isJson: vi.fn(() => false),
}));

describe("delete command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgent.com.atproto.repo.deleteRecord.mockResolvedValue({});
  });

  it("calls deleteRecord with correct collection and rkey", async () => {
    const program = new Command();
    program.option("--json", "Output as JSON");
    registerDelete(program);

    await program.parseAsync([
      "node",
      "test",
      "delete",
      "at://did:plc:abc/app.bsky.feed.post/123",
    ]);

    expect(mockAgent.com.atproto.repo.deleteRecord).toHaveBeenCalledWith({
      repo: "did:plc:test123",
      collection: "app.bsky.feed.post",
      rkey: "123",
    });
  });

  it("deletes multiple posts when given multiple URIs", async () => {
    const program = new Command();
    program.option("--json", "Output as JSON");
    registerDelete(program);

    await program.parseAsync([
      "node",
      "test",
      "delete",
      "at://did:plc:abc/app.bsky.feed.post/111",
      "at://did:plc:def/app.bsky.feed.post/222",
    ]);

    expect(mockAgent.com.atproto.repo.deleteRecord).toHaveBeenCalledTimes(2);

    expect(mockAgent.com.atproto.repo.deleteRecord).toHaveBeenCalledWith({
      repo: "did:plc:test123",
      collection: "app.bsky.feed.post",
      rkey: "111",
    });

    expect(mockAgent.com.atproto.repo.deleteRecord).toHaveBeenCalledWith({
      repo: "did:plc:test123",
      collection: "app.bsky.feed.post",
      rkey: "222",
    });
  });
});
