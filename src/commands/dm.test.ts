import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { createMockAgent } from "@/test-utils";

const mockAgent = createMockAgent();

vi.mock("@/index", () => ({
  getClient: vi.fn(() => Promise.resolve(mockAgent)),
  isJson: vi.fn(() => false),
}));

vi.mock("@/lib/format", () => ({
  formatTime: vi.fn((d: string) => d),
  outputJson: vi.fn(),
}));

import { registerDm } from "./dm";
import { isJson } from "@/index";
import { outputJson } from "@/lib/format";

const mockConvo = {
  id: "convo123",
  members: [
    { did: "did:plc:test123", handle: "test.bsky.social", displayName: "Test" },
    { did: "did:plc:other", handle: "alice.bsky.social", displayName: "Alice" },
  ],
  muted: false,
  status: "accepted",
  unreadCount: 2,
  lastMessage: { text: "Hey there!", sentAt: "2026-03-29T10:00:00Z" },
};

const mockMessage = {
  id: "msg001",
  text: "Hello!",
  sender: { did: "did:plc:other" },
  sentAt: "2026-03-29T10:00:00Z",
};

function createProgram() {
  const program = new Command();
  program.option("--json", "Output as JSON");
  program.exitOverride();
  registerDm(program);
  return program;
}

describe("dm list", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists conversations", async () => {
    mockAgent.chat.bsky.convo.listConvos.mockResolvedValue({
      data: { convos: [mockConvo], cursor: undefined },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "dm", "list"]);

    expect(mockAgent.configureProxy).toHaveBeenCalledWith(
      "did:web:api.bsky.chat#bsky_chat",
    );
    expect(mockAgent.chat.bsky.convo.listConvos).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("respects -n count", async () => {
    mockAgent.chat.bsky.convo.listConvos.mockResolvedValue({
      data: { convos: [mockConvo], cursor: undefined },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "dm", "list", "-n", "10"]);

    expect(mockAgent.chat.bsky.convo.listConvos).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10 }),
    );
    logSpy.mockRestore();
  });

  it("passes readState for --unread", async () => {
    mockAgent.chat.bsky.convo.listConvos.mockResolvedValue({
      data: { convos: [], cursor: undefined },
    });

    const program = createProgram();
    await program.parseAsync(["node", "test", "dm", "list", "--unread"]);

    expect(mockAgent.chat.bsky.convo.listConvos).toHaveBeenCalledWith(
      expect.objectContaining({ readState: "unread" }),
    );
  });

  it("passes status for --requests", async () => {
    mockAgent.chat.bsky.convo.listConvos.mockResolvedValue({
      data: { convos: [], cursor: undefined },
    });

    const program = createProgram();
    await program.parseAsync(["node", "test", "dm", "list", "--requests"]);

    expect(mockAgent.chat.bsky.convo.listConvos).toHaveBeenCalledWith(
      expect.objectContaining({ status: "request" }),
    );
  });

  it("outputs JSON when --json flag is set", async () => {
    (isJson as any).mockReturnValue(true);
    mockAgent.chat.bsky.convo.listConvos.mockResolvedValue({
      data: { convos: [mockConvo], cursor: undefined },
    });

    const program = createProgram();
    await program.parseAsync(["node", "test", "dm", "list"]);

    expect(outputJson).toHaveBeenCalledWith(mockConvo);
  });

  it("paginates with cursor", async () => {
    mockAgent.chat.bsky.convo.listConvos
      .mockResolvedValueOnce({
        data: { convos: [mockConvo], cursor: "page2" },
      })
      .mockResolvedValueOnce({
        data: { convos: [{ ...mockConvo, id: "convo456" }], cursor: undefined },
      });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "dm", "list", "-n", "100"]);

    expect(mockAgent.chat.bsky.convo.listConvos).toHaveBeenCalledTimes(2);
    logSpy.mockRestore();
  });
});

describe("dm read", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads messages by handle using getConvoAvailability", async () => {
    mockAgent.getProfile.mockResolvedValue({
      data: { did: "did:plc:other" },
    });
    mockAgent.chat.bsky.convo.getConvoAvailability.mockResolvedValue({
      data: { convo: mockConvo },
    });
    mockAgent.chat.bsky.convo.getMessages.mockResolvedValue({
      data: { messages: [mockMessage] },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "dm", "read", "alice.bsky.social"]);

    expect(mockAgent.chat.bsky.convo.getConvoAvailability).toHaveBeenCalledWith({
      members: ["did:plc:test123", "did:plc:other"],
    });
    expect(mockAgent.chat.bsky.convo.getMessages).toHaveBeenCalledWith({
      convoId: "convo123",
      limit: 30,
    });
    logSpy.mockRestore();
  });

  it("reads messages by convoId using getConvo", async () => {
    mockAgent.chat.bsky.convo.getConvo.mockResolvedValue({
      data: { convo: mockConvo },
    });
    mockAgent.chat.bsky.convo.getMessages.mockResolvedValue({
      data: { messages: [mockMessage] },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "dm", "read", "convo123"]);

    expect(mockAgent.chat.bsky.convo.getConvo).toHaveBeenCalledWith({
      convoId: "convo123",
    });
    logSpy.mockRestore();
  });

  it("errors when no conversation exists for handle", async () => {
    mockAgent.getProfile.mockResolvedValue({
      data: { did: "did:plc:other" },
    });
    mockAgent.chat.bsky.convo.getConvoAvailability.mockResolvedValue({
      data: { convo: null },
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "dm", "read", "nobody.bsky.social"]);

    expect(errSpy).toHaveBeenCalledWith(
      "No conversation found with nobody.bsky.social",
    );
    errSpy.mockRestore();
  });

  it("falls back to getConvoForMembers when getConvoAvailability is not implemented", async () => {
    const notImpl = new Error("method not implemented");
    (notImpl as any).status = 501;

    mockAgent.getProfile.mockResolvedValue({
      data: { did: "did:plc:other" },
    });
    mockAgent.chat.bsky.convo.getConvoAvailability.mockRejectedValue(notImpl);
    mockAgent.chat.bsky.convo.getConvoForMembers.mockResolvedValue({
      data: { convo: mockConvo },
    });
    mockAgent.chat.bsky.convo.getMessages.mockResolvedValue({
      data: { messages: [mockMessage] },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "dm", "read", "alice.bsky.social"]);

    expect(mockAgent.chat.bsky.convo.getConvoAvailability).toHaveBeenCalled();
    expect(mockAgent.chat.bsky.convo.getConvoForMembers).toHaveBeenCalledWith({
      members: ["did:plc:test123", "did:plc:other"],
    });
    expect(mockAgent.chat.bsky.convo.getMessages).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("outputs JSON when --json flag is set", async () => {
    (isJson as any).mockReturnValue(true);
    mockAgent.chat.bsky.convo.getConvo.mockResolvedValue({
      data: { convo: mockConvo },
    });
    mockAgent.chat.bsky.convo.getMessages.mockResolvedValue({
      data: { messages: [mockMessage] },
    });

    const program = createProgram();
    await program.parseAsync(["node", "test", "dm", "read", "convo123"]);

    expect(outputJson).toHaveBeenCalledWith(mockMessage);
  });
});

describe("dm send", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves handle and sends message", async () => {
    mockAgent.getProfile.mockResolvedValue({
      data: { did: "did:plc:other" },
    });
    mockAgent.chat.bsky.convo.getConvoForMembers.mockResolvedValue({
      data: { convo: { id: "convo123" } },
    });
    mockAgent.chat.bsky.convo.sendMessage.mockResolvedValue({
      data: { id: "msg002" },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync([
      "node", "test", "dm", "send", "alice.bsky.social", "Hello", "world!",
    ]);

    expect(mockAgent.chat.bsky.convo.getConvoForMembers).toHaveBeenCalledWith({
      members: ["did:plc:test123", "did:plc:other"],
    });
    expect(mockAgent.chat.bsky.convo.sendMessage).toHaveBeenCalledWith({
      convoId: "convo123",
      message: { text: "Hello world!" },
    });
    logSpy.mockRestore();
  });

  it("errors when no text provided", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "dm", "send", "alice.bsky.social"]);

    expect(errSpy).toHaveBeenCalledWith("No message text provided");
    errSpy.mockRestore();
  });
});

describe("dm delete", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes a message", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "dm", "delete", "convo123", "msg001"]);

    expect(mockAgent.chat.bsky.convo.deleteMessageForSelf).toHaveBeenCalledWith({
      convoId: "convo123",
      messageId: "msg001",
    });
    logSpy.mockRestore();
  });
});

describe("dm mute/unmute", () => {
  beforeEach(() => vi.clearAllMocks());

  it("mutes a conversation", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "dm", "mute", "convo123"]);

    expect(mockAgent.chat.bsky.convo.muteConvo).toHaveBeenCalledWith({
      convoId: "convo123",
    });
    logSpy.mockRestore();
  });

  it("unmutes a conversation", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "dm", "unmute", "convo123"]);

    expect(mockAgent.chat.bsky.convo.unmuteConvo).toHaveBeenCalledWith({
      convoId: "convo123",
    });
    logSpy.mockRestore();
  });
});

describe("dm accept", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts a conversation request", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "dm", "accept", "convo123"]);

    expect(mockAgent.chat.bsky.convo.acceptConvo).toHaveBeenCalledWith({
      convoId: "convo123",
    });
    logSpy.mockRestore();
  });

  it("shows fallback guidance when acceptConvo is not implemented", async () => {
    const notImpl = new Error("method not implemented");
    (notImpl as any).status = 501;
    mockAgent.chat.bsky.convo.acceptConvo.mockRejectedValue(notImpl);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "dm", "accept", "convo123"]);

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("not yet supported"),
    );
    errSpy.mockRestore();
  });
});

describe("dm mark-read", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks a specific conversation as read", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "dm", "mark-read", "convo123"]);

    expect(mockAgent.chat.bsky.convo.updateRead).toHaveBeenCalledWith({
      convoId: "convo123",
    });
    logSpy.mockRestore();
  });

  it("marks all conversations as read with --all", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "dm", "mark-read", "--all"]);

    expect(mockAgent.chat.bsky.convo.updateAllRead).toHaveBeenCalledWith({});
    logSpy.mockRestore();
  });

  it("falls back to per-convo updateRead when updateAllRead is not implemented", async () => {
    const notImpl = new Error("method not implemented");
    (notImpl as any).status = 501;
    mockAgent.chat.bsky.convo.updateAllRead.mockRejectedValue(notImpl);
    mockAgent.chat.bsky.convo.listConvos.mockResolvedValue({
      data: {
        convos: [
          { id: "convo1" },
          { id: "convo2" },
        ],
        cursor: undefined,
      },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "dm", "mark-read", "--all"]);

    expect(mockAgent.chat.bsky.convo.updateAllRead).toHaveBeenCalled();
    expect(mockAgent.chat.bsky.convo.listConvos).toHaveBeenCalledWith(
      expect.objectContaining({ readState: "unread" }),
    );
    expect(mockAgent.chat.bsky.convo.updateRead).toHaveBeenCalledWith({ convoId: "convo1" });
    expect(mockAgent.chat.bsky.convo.updateRead).toHaveBeenCalledWith({ convoId: "convo2" });
    logSpy.mockRestore();
  });

  it("errors when no convoId and no --all", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "test", "dm", "mark-read"]);

    expect(errSpy).toHaveBeenCalledWith(
      "Provide a conversation ID or use --all",
    );
    errSpy.mockRestore();
  });
});

describe("dm proxy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("configures chat proxy for all commands", async () => {
    mockAgent.chat.bsky.convo.listConvos.mockResolvedValue({
      data: { convos: [], cursor: undefined },
    });

    const program = createProgram();
    await program.parseAsync(["node", "test", "dm", "list"]);

    expect(mockAgent.configureProxy).toHaveBeenCalledWith(
      "did:web:api.bsky.chat#bsky_chat",
    );
  });
});
