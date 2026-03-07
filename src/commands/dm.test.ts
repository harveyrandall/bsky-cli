import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { createMockAgent } from "@/test-utils";

const mockAgent = createMockAgent();

vi.mock("@/index", () => ({
  getClient: vi.fn(() => Promise.resolve(mockAgent)),
  isJson: vi.fn(() => false),
}));

vi.mock("@/lib/format", () => ({
  printConvo: vi.fn(),
  printMessage: vi.fn(),
  outputJson: vi.fn(),
  formatTime: vi.fn((d: string) => d),
}));

import { registerDm } from "./dm";
import { isJson } from "@/index";
import { printConvo, printMessage, outputJson } from "@/lib/format";

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("--json", "Output as JSON");
  registerDm(program);
  return program;
}

const mockConvo = {
  id: "convo-123",
  members: [
    { did: "did:plc:test123", handle: "test.bsky.social" },
    { did: "did:plc:alice", handle: "alice.bsky.social", displayName: "Alice" },
  ],
  unreadCount: 2,
  muted: false,
  lastMessage: { text: "Hello!", sentAt: "2026-03-07T12:00:00.000Z", sender: { did: "did:plc:alice" } },
};

const mockMessage = {
  $type: "chat.bsky.convo.defs#messageView",
  id: "msg-001",
  rev: "1",
  text: "Hey there!",
  sender: { did: "did:plc:alice" },
  sentAt: "2026-03-07T12:00:00.000Z",
};

describe("dm commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isJson as any).mockReturnValue(false);

    mockAgent.getProfile.mockResolvedValue({
      data: { did: "did:plc:alice", handle: "alice.bsky.social" },
    });
    mockAgent.chat.bsky.convo.getConvoForMembers.mockResolvedValue({
      data: { convo: mockConvo },
    });
  });

  describe("list", () => {
    it("lists conversations and calls printConvo for each", async () => {
      mockAgent.chat.bsky.convo.listConvos.mockResolvedValue({
        data: { convos: [mockConvo], cursor: undefined },
      });

      const program = makeProgram();
      await program.parseAsync(["dm", "list"], { from: "user" });

      expect(mockAgent.chat.bsky.convo.listConvos).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 50 }),
      );
      expect(printConvo).toHaveBeenCalledWith(mockConvo, "did:plc:test123");
    });

    it("passes --unread filter to readState", async () => {
      mockAgent.chat.bsky.convo.listConvos.mockResolvedValue({
        data: { convos: [], cursor: undefined },
      });

      const program = makeProgram();
      await program.parseAsync(["dm", "list", "--unread"], { from: "user" });

      expect(mockAgent.chat.bsky.convo.listConvos).toHaveBeenCalledWith(
        expect.objectContaining({ readState: "unread" }),
      );
    });

    it("passes --requests filter to status", async () => {
      mockAgent.chat.bsky.convo.listConvos.mockResolvedValue({
        data: { convos: [], cursor: undefined },
      });

      const program = makeProgram();
      await program.parseAsync(["dm", "list", "--requests"], { from: "user" });

      expect(mockAgent.chat.bsky.convo.listConvos).toHaveBeenCalledWith(
        expect.objectContaining({ status: "request" }),
      );
    });

    it("outputs JSON when --json is set", async () => {
      (isJson as any).mockReturnValue(true);
      mockAgent.chat.bsky.convo.listConvos.mockResolvedValue({
        data: { convos: [mockConvo], cursor: undefined },
      });

      const program = makeProgram();
      await program.parseAsync(["dm", "list"], { from: "user" });

      expect(outputJson).toHaveBeenCalledWith(mockConvo);
      expect(printConvo).not.toHaveBeenCalled();
    });

    it("paginates through multiple pages", async () => {
      mockAgent.chat.bsky.convo.listConvos
        .mockResolvedValueOnce({
          data: { convos: [mockConvo], cursor: "cursor-1" },
        })
        .mockResolvedValueOnce({
          data: { convos: [{ ...mockConvo, id: "convo-456" }], cursor: undefined },
        });

      const program = makeProgram();
      await program.parseAsync(["dm", "list"], { from: "user" });

      expect(mockAgent.chat.bsky.convo.listConvos).toHaveBeenCalledTimes(2);
      expect(printConvo).toHaveBeenCalledTimes(2);
    });
  });

  describe("read", () => {
    it("resolves handle, fetches convo and messages, reverses for display", async () => {
      const msg1 = { ...mockMessage, id: "msg-001", sentAt: "2026-03-07T12:00:00.000Z" };
      const msg2 = { ...mockMessage, id: "msg-002", sentAt: "2026-03-07T11:00:00.000Z" };

      mockAgent.chat.bsky.convo.getConvo.mockResolvedValue({
        data: { convo: mockConvo },
      });
      mockAgent.chat.bsky.convo.getMessages.mockResolvedValue({
        data: { messages: [msg1, msg2] },
      });

      const program = makeProgram();
      await program.parseAsync(["dm", "read", "alice.bsky.social"], { from: "user" });

      expect(mockAgent.getProfile).toHaveBeenCalledWith({ actor: "alice.bsky.social" });
      expect(mockAgent.chat.bsky.convo.getMessages).toHaveBeenCalledWith(
        expect.objectContaining({ convoId: "convo-123", limit: 30 }),
      );
      // Messages are reversed — msg2 (older) should be printed first
      expect(printMessage).toHaveBeenCalledTimes(2);
      const firstCall = (printMessage as any).mock.calls[0];
      expect(firstCall[0].id).toBe("msg-002");
    });

    it("skips getProfile when input is a DID", async () => {
      mockAgent.chat.bsky.convo.getConvo.mockResolvedValue({
        data: { convo: mockConvo },
      });
      mockAgent.chat.bsky.convo.getMessages.mockResolvedValue({
        data: { messages: [] },
      });

      const program = makeProgram();
      await program.parseAsync(["dm", "read", "did:plc:alice"], { from: "user" });

      expect(mockAgent.getProfile).not.toHaveBeenCalled();
      expect(mockAgent.chat.bsky.convo.getConvoForMembers).toHaveBeenCalledWith({
        members: ["did:plc:test123", "did:plc:alice"],
      });
    });

    it("outputs JSON when --json is set", async () => {
      (isJson as any).mockReturnValue(true);
      mockAgent.chat.bsky.convo.getConvo.mockResolvedValue({
        data: { convo: mockConvo },
      });
      mockAgent.chat.bsky.convo.getMessages.mockResolvedValue({
        data: { messages: [mockMessage] },
      });

      const program = makeProgram();
      await program.parseAsync(["dm", "read", "alice.bsky.social"], { from: "user" });

      expect(outputJson).toHaveBeenCalledWith(mockMessage);
      expect(printMessage).not.toHaveBeenCalled();
    });
  });

  describe("send", () => {
    it("resolves handle, sends message, prints message ID", async () => {
      mockAgent.chat.bsky.convo.sendMessage.mockResolvedValue({
        data: { id: "msg-new-001" },
      });

      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      const program = makeProgram();
      await program.parseAsync(["dm", "send", "alice.bsky.social", "Hello", "world"], { from: "user" });

      expect(mockAgent.chat.bsky.convo.sendMessage).toHaveBeenCalledWith({
        convoId: "convo-123",
        message: { text: "Hello world" },
      });
      expect(spy).toHaveBeenCalledWith("msg-new-001");
      spy.mockRestore();
    });
  });

  describe("delete", () => {
    it("resolves convoId and deletes message", async () => {
      mockAgent.chat.bsky.convo.deleteMessageForSelf.mockResolvedValue({
        data: { id: "msg-del", sender: { did: "did:plc:test123" }, sentAt: "2026-03-07T12:00:00.000Z" },
      });

      const program = makeProgram();
      await program.parseAsync(["dm", "delete", "alice.bsky.social", "msg-del"], { from: "user" });

      expect(mockAgent.chat.bsky.convo.deleteMessageForSelf).toHaveBeenCalledWith({
        convoId: "convo-123",
        messageId: "msg-del",
      });
    });
  });

  describe("accept", () => {
    it("resolves convoId and accepts conversation", async () => {
      mockAgent.chat.bsky.convo.acceptConvo.mockResolvedValue({ data: {} });

      const program = makeProgram();
      await program.parseAsync(["dm", "accept", "alice.bsky.social"], { from: "user" });

      expect(mockAgent.chat.bsky.convo.acceptConvo).toHaveBeenCalledWith({
        convoId: "convo-123",
      });
    });
  });

  describe("mark-read", () => {
    it("resolves convoId and marks as read", async () => {
      mockAgent.chat.bsky.convo.updateRead.mockResolvedValue({
        data: { convo: mockConvo },
      });

      const program = makeProgram();
      await program.parseAsync(["dm", "mark-read", "alice.bsky.social"], { from: "user" });

      expect(mockAgent.chat.bsky.convo.updateRead).toHaveBeenCalledWith({
        convoId: "convo-123",
      });
    });
  });

  describe("mute", () => {
    it("resolves convoId and mutes conversation", async () => {
      mockAgent.chat.bsky.convo.muteConvo.mockResolvedValue({ data: {} });

      const program = makeProgram();
      await program.parseAsync(["dm", "mute", "alice.bsky.social"], { from: "user" });

      expect(mockAgent.chat.bsky.convo.muteConvo).toHaveBeenCalledWith({
        convoId: "convo-123",
      });
    });
  });

  describe("unmute", () => {
    it("resolves convoId and unmutes conversation", async () => {
      mockAgent.chat.bsky.convo.unmuteConvo.mockResolvedValue({ data: {} });

      const program = makeProgram();
      await program.parseAsync(["dm", "unmute", "alice.bsky.social"], { from: "user" });

      expect(mockAgent.chat.bsky.convo.unmuteConvo).toHaveBeenCalledWith({
        convoId: "convo-123",
      });
    });
  });
});
