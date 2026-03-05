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

import { registerNotifs } from "@/commands/notification";
import { isJson } from "@/index";
import { outputJson } from "@/lib/format";

function makeProgram(register: (cmd: Command) => void): Command {
  const program = new Command();
  program.exitOverride();
  program.option("--json", "Output as JSON");
  register(program);
  return program;
}

const mockNotifications = [
  {
    uri: "at://did:plc:author1/app.bsky.feed.post/1",
    author: {
      handle: "alice.bsky.social",
      displayName: "Alice",
      did: "did:plc:alice",
    },
    reason: "reply",
    isRead: false,
    record: {
      $type: "app.bsky.feed.post",
      text: "Hello!",
    },
  },
  {
    uri: "at://did:plc:author2/app.bsky.feed.repost/2",
    author: {
      handle: "bob.bsky.social",
      displayName: "Bob",
      did: "did:plc:bob",
    },
    reason: "repost",
    isRead: true,
    record: {
      $type: "app.bsky.feed.repost",
      subject: {
        uri: "at://did:plc:test123/app.bsky.feed.post/original",
        cid: "bafyreicid",
      },
      createdAt: "2025-01-01T00:00:00Z",
    },
  },
  {
    uri: "at://did:plc:author3/app.bsky.feed.like/3",
    author: {
      handle: "charlie.bsky.social",
      displayName: "Charlie",
      did: "did:plc:charlie",
    },
    reason: "like",
    isRead: false,
    record: {
      $type: "app.bsky.feed.like",
      subject: {
        uri: "at://did:plc:test123/app.bsky.feed.post/liked",
        cid: "bafyreicid2",
      },
      createdAt: "2025-01-01T00:00:00Z",
    },
  },
  {
    uri: "at://did:plc:author4/app.bsky.graph.follow/4",
    author: {
      handle: "dana.bsky.social",
      displayName: "Dana",
      did: "did:plc:dana",
    },
    reason: "follow",
    isRead: false,
    record: {
      $type: "app.bsky.graph.follow",
      subject: "did:plc:test123",
      createdAt: "2025-01-01T00:00:00Z",
    },
  },
];

describe("notifs command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isJson as any).mockReturnValue(false);

    mockAgent.listNotifications.mockResolvedValue({
      data: { notifications: mockNotifications },
    });
  });

  it("lists unread notifications", async () => {
    const program = makeProgram(registerNotifs);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await program.parseAsync(["notifs"], { from: "user" });

    // Bob (isRead: true) should be filtered out, so only 3 notifications shown
    // Alice - post
    const allOutput = [
      ...consoleSpy.mock.calls.map((c) => c.join(" ")),
      ...stdoutSpy.mock.calls.map((c) => String(c[0])),
    ].join("\n");

    expect(allOutput).toContain("alice.bsky.social");
    expect(allOutput).toContain("charlie.bsky.social");
    expect(allOutput).toContain("dana.bsky.social");
    // Bob should be filtered (isRead: true, no --all)
    expect(allOutput).not.toContain("bob.bsky.social");
    expect(allOutput).toContain("followed you");
    expect(allOutput).toContain("liked");

    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it("shows read notifications with --all", async () => {
    const program = makeProgram(registerNotifs);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await program.parseAsync(["notifs", "--all"], { from: "user" });

    const allOutput = [
      ...consoleSpy.mock.calls.map((c) => c.join(" ")),
      ...stdoutSpy.mock.calls.map((c) => String(c[0])),
    ].join("\n");

    // All notifications should be shown, including Bob (isRead: true)
    expect(allOutput).toContain("alice.bsky.social");
    expect(allOutput).toContain("bob.bsky.social");
    expect(allOutput).toContain("charlie.bsky.social");
    expect(allOutput).toContain("dana.bsky.social");

    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it("calls updateSeen after listing notifications", async () => {
    const program = makeProgram(registerNotifs);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await program.parseAsync(["notifs"], { from: "user" });

    expect(
      mockAgent.app.bsky.notification.updateSeen,
    ).toHaveBeenCalledTimes(1);
    const call =
      mockAgent.app.bsky.notification.updateSeen.mock.calls[0][0];
    expect(call).toHaveProperty("seenAt");
    expect(typeof call.seenAt).toBe("string");

    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it("outputs JSON for each notification in JSON mode", async () => {
    (isJson as any).mockReturnValue(true);

    const program = makeProgram(registerNotifs);

    await program.parseAsync(["notifs"], { from: "user" });

    expect(outputJson).toHaveBeenCalledTimes(mockNotifications.length);
    for (const n of mockNotifications) {
      expect(outputJson).toHaveBeenCalledWith(n);
    }
  });
});
