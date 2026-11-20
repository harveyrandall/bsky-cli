import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { createMockAgent } from "@/test-utils";
import { registerDelete } from "@/commands/delete";

const mockAgent = createMockAgent();

vi.mock("@/index", () => ({
  getClient: vi.fn(() => Promise.resolve(mockAgent)),
  isJson: vi.fn(() => false),
}));

/** What the PDS sends when it deleted something. With nothing there, it leaves `commit` out. */
const deleted = { data: { commit: { cid: "bafycommit", rev: "rev1" } } };

describe("delete command", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  const run = (...uris: string[]) => {
    const program = new Command();
    program.option("--json", "Output as JSON");
    registerDelete(program);
    return program.parseAsync(["node", "test", "delete", ...uris]);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAgent.com.atproto.repo.deleteRecord.mockResolvedValue(deleted);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = undefined;
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("calls deleteRecord with correct collection and rkey", async () => {
    await run("at://did:plc:test123/app.bsky.feed.post/123");

    expect(mockAgent.com.atproto.repo.deleteRecord).toHaveBeenCalledWith({
      repo: "did:plc:test123",
      collection: "app.bsky.feed.post",
      rkey: "123",
    });
  });

  it("deletes multiple posts when given multiple URIs", async () => {
    await run("at://did:plc:test123/app.bsky.feed.post/111", "at://did:plc:test123/app.bsky.feed.post/222");

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

  it("prints each post it deleted", async () => {
    await run("at://did:plc:test123/app.bsky.feed.post/111", "at://did:plc:test123/app.bsky.feed.post/222");

    expect(logSpy.mock.calls).toEqual([
      ["at://did:plc:test123/app.bsky.feed.post/111"],
      ["at://did:plc:test123/app.bsky.feed.post/222"],
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it("takes a URI without at://did:plc:, or with your handle", async () => {
    await run("test123/app.bsky.feed.post/111", "at://test.bsky.social/app.bsky.feed.post/222");

    expect(mockAgent.com.atproto.repo.deleteRecord).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls).toEqual([
      ["at://did:plc:test123/app.bsky.feed.post/111"],
      ["at://did:plc:test123/app.bsky.feed.post/222"],
    ]);
  });

  it("prints a post only once it's deleted", async () => {
    let finish!: (value: typeof deleted) => void;
    mockAgent.com.atproto.repo.deleteRecord.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));

    const running = run("at://did:plc:test123/app.bsky.feed.post/111");
    await vi.waitFor(() => expect(mockAgent.com.atproto.repo.deleteRecord).toHaveBeenCalled());
    expect(logSpy).not.toHaveBeenCalled();

    finish(deleted);
    await running;
    expect(logSpy).toHaveBeenCalledWith("at://did:plc:test123/app.bsky.feed.post/111");
  });

  it("says when there was nothing to delete, printing no URI", async () => {
    mockAgent.com.atproto.repo.deleteRecord.mockResolvedValueOnce({ data: {} });

    await run("at://did:plc:test123/app.bsky.feed.post/111");

    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith("Nothing to delete at at://did:plc:test123/app.bsky.feed.post/111");
    expect(process.exitCode).toBeUndefined();
  });

  it("refuses another account's post, and carries on with the rest", async () => {
    await run("at://did:plc:abc/app.bsky.feed.post/111", "at://did:plc:test123/app.bsky.feed.post/222");

    expect(errSpy).toHaveBeenCalledWith("That isn't yours: at://did:plc:abc/app.bsky.feed.post/111");
    expect(mockAgent.com.atproto.repo.deleteRecord).toHaveBeenCalledTimes(1);
    expect(mockAgent.com.atproto.repo.deleteRecord).toHaveBeenCalledWith(expect.objectContaining({ rkey: "222" }));
    expect(logSpy.mock.calls).toEqual([["at://did:plc:test123/app.bsky.feed.post/222"]]);
    expect(process.exitCode).toBe(1);
  });

  it("refuses anything but a post", async () => {
    await run("at://did:plc:test123/app.bsky.feed.like/111");

    expect(errSpy).toHaveBeenCalledWith("delete takes a post's URI, not app.bsky.feed.like: at://did:plc:test123/app.bsky.feed.like/111");
    expect(mockAgent.com.atproto.repo.deleteRecord).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("prints nothing for a post it couldn't delete", async () => {
    mockAgent.com.atproto.repo.deleteRecord.mockRejectedValue(new Error("offline"));

    await expect(run("at://did:plc:test123/app.bsky.feed.post/111")).rejects.toThrow("offline");

    expect(logSpy).not.toHaveBeenCalled();
  });
});
