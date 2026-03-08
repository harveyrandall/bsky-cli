import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { createMockAgent } from "@/test-utils";

const mockAgent = createMockAgent();

vi.mock("@/index", () => ({
  getClient: vi.fn(() => Promise.resolve(mockAgent)),
  isJson: vi.fn(() => false),
}));

vi.mock("@/lib/format", () => ({
  outputJson: vi.fn(),
}));

const mockListDrafts = vi.fn();
const mockLoadDraft = vi.fn();
const mockDeleteDraft = vi.fn();
const mockResolveDraftId = vi.fn();
vi.mock("@/drafts", () => ({
  listDrafts: (...args: unknown[]) => mockListDrafts(...args),
  loadDraft: (...args: unknown[]) => mockLoadDraft(...args),
  deleteDraft: (...args: unknown[]) => mockDeleteDraft(...args),
  resolveDraftId: (...args: unknown[]) => mockResolveDraftId(...args),
}));

const mockCreatePost = vi.fn();
vi.mock("@/commands/post", () => ({
  createPost: (...args: unknown[]) => mockCreatePost(...args),
}));

import { registerDrafts, syncNetworkDrafts } from "./draft";
import { isJson } from "@/index";
import { outputJson } from "@/lib/format";

function createProgram() {
  const program = new Command();
  program.option("--json", "Output as JSON");
  program.option("-p, --profile <name>");
  program.exitOverride();
  registerDrafts(program);
  return program;
}

const sampleDraft = {
  id: "1741392000000-a7f3",
  createdAt: "2025-03-07T12:00:00.000Z",
  reason: "manual" as const,
  type: "post" as const,
  text: "Hello world",
};

describe("drafts list", () => {
  beforeEach(() => vi.clearAllMocks());

  it("prints 'No drafts found' when empty", async () => {
    mockListDrafts.mockResolvedValue([]);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "drafts", "list"]);

    expect(consoleSpy).toHaveBeenCalledWith("No drafts found.");
    consoleSpy.mockRestore();
  });

  it("displays previews truncated to 80 chars with reason tags", async () => {
    const longText = "A".repeat(100);
    mockListDrafts.mockResolvedValue([
      { ...sampleDraft, text: longText },
      {
        ...sampleDraft,
        id: "1741395600000-b2e1",
        reason: "network",
        type: "reply",
        text: "My reply",
      },
    ]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "drafts", "list"]);

    // First draft: truncated text, no reason tag (manual)
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("1741392000000-a7f3"),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("..."),
    );

    // Second draft: [reply] type label and [offline] reason tag
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("[offline]"),
    );

    logSpy.mockRestore();
  });

  it("outputs JSON when --json flag is set", async () => {
    (isJson as any).mockReturnValueOnce(true);
    mockListDrafts.mockResolvedValue([sampleDraft]);

    const program = createProgram();
    await program.parseAsync(["node", "test", "drafts", "list"]);

    expect(outputJson).toHaveBeenCalledWith(sampleDraft);
  });

  it("shows image count when draft has images", async () => {
    mockListDrafts.mockResolvedValue([
      { ...sampleDraft, images: ["/tmp/a.jpg", "/tmp/b.jpg"] },
    ]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "drafts", "list"]);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("2 image(s)"),
    );

    logSpy.mockRestore();
  });
});

describe("drafts show", () => {
  beforeEach(() => vi.clearAllMocks());

  it("displays full draft with all metadata", async () => {
    mockResolveDraftId.mockResolvedValue("1741392000000-a7f3");
    mockLoadDraft.mockResolvedValue({
      ...sampleDraft,
      replyUri: "at://did:plc:abc/app.bsky.feed.post/123",
      images: ["/tmp/photo.jpg"],
      imageAlts: ["A nice photo"],
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "drafts", "show", "174139200"]);

    expect(mockResolveDraftId).toHaveBeenCalledWith("174139200", undefined);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("1741392000000-a7f3"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Hello world"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Reply to:"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("A nice photo"));

    logSpy.mockRestore();
  });

  it("outputs JSON when --json flag is set", async () => {
    (isJson as any).mockReturnValueOnce(true);
    mockResolveDraftId.mockResolvedValue("1741392000000-a7f3");
    mockLoadDraft.mockResolvedValue(sampleDraft);

    const program = createProgram();
    await program.parseAsync(["node", "test", "drafts", "show", "174139200"]);

    expect(outputJson).toHaveBeenCalledWith(sampleDraft);
  });
});

describe("drafts send", () => {
  beforeEach(() => vi.clearAllMocks());

  it("publishes a simple post draft and deletes it", async () => {
    mockResolveDraftId.mockResolvedValue("1741392000000-a7f3");
    mockLoadDraft.mockResolvedValue(sampleDraft);
    mockCreatePost.mockResolvedValue("at://did:plc:test/app.bsky.feed.post/new");
    mockDeleteDraft.mockResolvedValue(undefined);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "drafts", "send", "174139200"]);

    expect(mockCreatePost).toHaveBeenCalledWith(
      mockAgent,
      "Hello world",
      expect.objectContaining({}),
    );
    expect(mockDeleteDraft).toHaveBeenCalledWith("1741392000000-a7f3", undefined);
    expect(logSpy).toHaveBeenCalledWith("at://did:plc:test/app.bsky.feed.post/new");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("published and removed"),
    );

    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("re-fetches parent post for reply drafts", async () => {
    const replyDraft = {
      ...sampleDraft,
      type: "reply" as const,
      replyUri: "at://did:plc:abc/app.bsky.feed.post/123",
    };
    mockResolveDraftId.mockResolvedValue("1741392000000-a7f3");
    mockLoadDraft.mockResolvedValue(replyDraft);
    mockCreatePost.mockResolvedValue("at://did:plc:test/app.bsky.feed.post/reply1");
    mockDeleteDraft.mockResolvedValue(undefined);

    mockAgent.com.atproto.repo.getRecord.mockResolvedValue({
      data: {
        uri: "at://did:plc:abc/app.bsky.feed.post/123",
        cid: "bafyreicid-parent",
        value: {
          $type: "app.bsky.feed.post",
          text: "Parent",
          createdAt: "2025-01-01T00:00:00Z",
        },
      },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "drafts", "send", "174139200"]);

    expect(mockAgent.com.atproto.repo.getRecord).toHaveBeenCalledWith({
      repo: "did:plc:abc",
      collection: "app.bsky.feed.post",
      rkey: "123",
    });

    expect(mockCreatePost).toHaveBeenCalledWith(
      mockAgent,
      "Hello world",
      expect.objectContaining({
        reply: {
          uri: "at://did:plc:abc/app.bsky.feed.post/123",
          cid: "bafyreicid-parent",
        },
      }),
    );

    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("re-fetches quote record for quote drafts", async () => {
    const quoteDraft = {
      ...sampleDraft,
      type: "quote" as const,
      quoteUri: "at://did:plc:xyz/app.bsky.feed.post/456",
    };
    mockResolveDraftId.mockResolvedValue("1741392000000-a7f3");
    mockLoadDraft.mockResolvedValue(quoteDraft);
    mockCreatePost.mockResolvedValue("at://did:plc:test/app.bsky.feed.post/quote1");
    mockDeleteDraft.mockResolvedValue(undefined);

    mockAgent.com.atproto.repo.getRecord.mockResolvedValue({
      data: {
        uri: "at://did:plc:xyz/app.bsky.feed.post/456",
        cid: "bafyreicid-quoted",
        value: {
          $type: "app.bsky.feed.post",
          text: "Quoted",
          createdAt: "2025-01-01T00:00:00Z",
        },
      },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "drafts", "send", "174139200"]);

    expect(mockAgent.com.atproto.repo.getRecord).toHaveBeenCalledWith({
      repo: "did:plc:xyz",
      collection: "app.bsky.feed.post",
      rkey: "456",
    });

    expect(mockCreatePost).toHaveBeenCalledWith(
      mockAgent,
      "Hello world",
      expect.objectContaining({
        quote: {
          uri: "at://did:plc:xyz/app.bsky.feed.post/456",
          cid: "bafyreicid-quoted",
        },
      }),
    );

    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});

describe("drafts delete", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removes draft by ID", async () => {
    mockResolveDraftId.mockResolvedValue("1741392000000-a7f3");
    mockDeleteDraft.mockResolvedValue(undefined);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "drafts", "delete", "174139200"]);

    expect(mockDeleteDraft).toHaveBeenCalledWith("1741392000000-a7f3", undefined);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("deleted"),
    );

    errSpy.mockRestore();
  });
});

describe("syncNetworkDrafts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skips when no network drafts exist", async () => {
    mockListDrafts.mockResolvedValue([
      { ...sampleDraft, reason: "manual" },
    ]);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await syncNetworkDrafts(mockAgent as any);

    expect(mockCreatePost).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("offline"),
    );

    errSpy.mockRestore();
  });

  it("notifies without prompting in non-TTY", async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    mockListDrafts.mockResolvedValue([
      { ...sampleDraft, reason: "network" },
    ]);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await syncNetworkDrafts(mockAgent as any);

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("1 draft(s) saved while offline"),
    );
    expect(mockCreatePost).not.toHaveBeenCalled();

    errSpy.mockRestore();
    Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
  });
});
