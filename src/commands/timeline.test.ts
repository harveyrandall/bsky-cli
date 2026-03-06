import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Command } from "commander";
import { createMockAgent } from "@/test-utils";

const mockAgent = createMockAgent();

// vi.hoisted runs before vi.mock hoisting — makes MockWebSocket available to factories
const { MockWebSocket } = vi.hoisted(() => {
  const { EventEmitter } = require("node:events");
  class MockWebSocket extends EventEmitter {
    static lastUrl = "";
    static lastInstance: any = null;
    constructor(url: string) {
      super();
      MockWebSocket.lastUrl = url;
      MockWebSocket.lastInstance = this;
    }
    close() {}
  }
  return { MockWebSocket };
});

vi.mock("@/index", () => ({
  getClient: vi.fn(() => Promise.resolve(mockAgent)),
  isJson: vi.fn(() => false),
}));

vi.mock("@/lib/format", () => ({
  printPost: vi.fn(),
  printStreamPost: vi.fn(),
  outputJson: vi.fn(),
}));

vi.mock("ws", () => ({
  default: MockWebSocket,
}));

import { registerTimeline, registerStream } from "@/commands/timeline";
import { isJson } from "@/index";
import { printPost, printStreamPost, outputJson } from "@/lib/format";

function makeProgram(register: (cmd: Command) => void): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

function makeFeedItem(text: string, createdAt: string) {
  return {
    post: {
      uri: `at://did:plc:test/app.bsky.feed.post/${text}`,
      author: { handle: "user.bsky.social", displayName: "User" },
      record: {
        $type: "app.bsky.feed.post",
        text,
        createdAt,
      },
      likeCount: 0,
      repostCount: 0,
      replyCount: 0,
    },
  };
}

describe("timeline command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isJson as any).mockReturnValue(false);
  });

  it("fetches and prints posts sorted by date ascending", async () => {
    const older = makeFeedItem("older post", "2025-01-01T00:00:00Z");
    const newer = makeFeedItem("newer post", "2025-01-02T00:00:00Z");

    mockAgent.getTimeline.mockResolvedValue({
      data: {
        feed: [newer, older],
        cursor: undefined,
      },
    });

    const program = makeProgram(registerTimeline);
    await program.parseAsync(["timeline"], { from: "user" });

    expect(mockAgent.getTimeline).toHaveBeenCalled();
    expect(printPost).toHaveBeenCalledTimes(2);
    // First call should be the older post (ascending sort)
    expect((printPost as any).mock.calls[0][0]).toBe(older.post);
    expect((printPost as any).mock.calls[1][0]).toBe(newer.post);
  });

  it("with --handle uses getAuthorFeed", async () => {
    const item = makeFeedItem("alice post", "2025-01-01T00:00:00Z");

    mockAgent.getAuthorFeed.mockResolvedValue({
      data: {
        feed: [item],
        cursor: undefined,
      },
    });

    const program = makeProgram(registerTimeline);
    await program.parseAsync(["timeline", "--handle", "alice.bsky.social"], {
      from: "user",
    });

    expect(mockAgent.getAuthorFeed).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "alice.bsky.social" }),
    );
  });

  it("with --handle self uses session DID", async () => {
    const item = makeFeedItem("my post", "2025-01-01T00:00:00Z");

    mockAgent.getAuthorFeed.mockResolvedValue({
      data: {
        feed: [item],
        cursor: undefined,
      },
    });

    const program = makeProgram(registerTimeline);
    await program.parseAsync(["timeline", "--handle", "self"], {
      from: "user",
    });

    expect(mockAgent.getAuthorFeed).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "did:plc:test123" }),
    );
  });

  it("in JSON mode uses outputJson", async () => {
    (isJson as any).mockReturnValue(true);

    const item = makeFeedItem("json post", "2025-01-01T00:00:00Z");

    mockAgent.getTimeline.mockResolvedValue({
      data: {
        feed: [item],
        cursor: undefined,
      },
    });

    const program = makeProgram(registerTimeline);
    await program.parseAsync(["timeline"], { from: "user" });

    expect(outputJson).toHaveBeenCalledWith(item);
    expect(printPost).not.toHaveBeenCalled();
  });
});

// Helper: create a Jetstream commit event for a new post
function makeJetstreamPost(did: string, rkey: string, text: string) {
  return JSON.stringify({
    did,
    time_us: 1234567890000000,
    kind: "commit",
    commit: {
      rev: "rev123",
      operation: "create",
      collection: "app.bsky.feed.post",
      rkey,
      record: {
        $type: "app.bsky.feed.post",
        text,
        createdAt: "2025-01-01T00:00:00Z",
      },
    },
  });
}

describe("stream command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isJson as any).mockReturnValue(false);
    MockWebSocket.lastUrl = "";
    MockWebSocket.lastInstance = null;
  });

  // Fire-and-forget parseAsync (it awaits forever), wait for WS to connect
  async function startStream(
    args: string[] = ["stream"],
  ): Promise<InstanceType<typeof MockWebSocket>> {
    const program = new Command();
    program.option("--json", "Output as JSON");
    program.option("-p, --profile <name>", "Profile name");
    registerStream(program);
    // Don't await — the action hangs on `new Promise(() => {})`
    program.parseAsync(["node", "test", ...args]);
    // Wait a tick for the action to run and create the WebSocket
    await new Promise((r) => setTimeout(r, 50));
    return MockWebSocket.lastInstance!;
  }

  it("connects to default Jetstream endpoint with wantedCollections", async () => {
    const ws = await startStream();
    expect(ws).toBeTruthy();
    expect(MockWebSocket.lastUrl).toContain(
      "jetstream1.us-east.bsky.network/subscribe",
    );
    expect(MockWebSocket.lastUrl).toContain(
      "wantedCollections=app.bsky.feed.post",
    );
  });

  it("calls printStreamPost for post create events", async () => {
    const ws = await startStream();
    const msg = makeJetstreamPost("did:plc:abc", "post1", "Hello world!");
    ws.emit("message", Buffer.from(msg));

    expect(printStreamPost).toHaveBeenCalledWith(
      "did:plc:abc",
      null,
      "Hello world!",
      "post1",
      "app.bsky.feed.post",
    );
  });

  it("skips non-create operations", async () => {
    const ws = await startStream();
    const deleteEvent = JSON.stringify({
      did: "did:plc:abc",
      time_us: 1234567890000000,
      kind: "commit",
      commit: {
        rev: "rev123",
        operation: "delete",
        collection: "app.bsky.feed.post",
        rkey: "post1",
      },
    });
    ws.emit("message", Buffer.from(deleteEvent));

    expect(printStreamPost).not.toHaveBeenCalled();
  });

  it("skips non-commit events", async () => {
    const ws = await startStream();
    const identityEvent = JSON.stringify({
      did: "did:plc:abc",
      time_us: 1234567890000000,
      kind: "identity",
      identity: { did: "did:plc:abc", handle: "alice.bsky.social", seq: 1, time: "2025-01-01" },
    });
    ws.emit("message", Buffer.from(identityEvent));

    expect(printStreamPost).not.toHaveBeenCalled();
  });

  it("applies --pattern regex filter", async () => {
    const ws = await startStream(["stream", "--pattern", "hello"]);

    // Should be filtered out (no match)
    ws.emit(
      "message",
      Buffer.from(makeJetstreamPost("did:plc:abc", "p1", "goodbye world")),
    );
    expect(printStreamPost).not.toHaveBeenCalled();

    // Should pass filter
    ws.emit(
      "message",
      Buffer.from(makeJetstreamPost("did:plc:abc", "p2", "hello world")),
    );
    expect(printStreamPost).toHaveBeenCalledTimes(1);
  });

  it("outputs full JSON events in json mode", async () => {
    (isJson as any).mockReturnValue(true);
    const ws = await startStream(["stream", "--json"]);
    const msg = makeJetstreamPost("did:plc:abc", "post1", "Hello!");
    ws.emit("message", Buffer.from(msg));

    expect(outputJson).toHaveBeenCalledWith(
      expect.objectContaining({
        did: "did:plc:abc",
        kind: "commit",
      }),
    );
    expect(printStreamPost).not.toHaveBeenCalled();
  });

  it("sets cursor query param when --cursor is provided", async () => {
    await startStream(["stream", "--cursor", "1234567890000000"]);
    expect(MockWebSocket.lastUrl).toContain("cursor=1234567890000000");
  });

  // --- pattern-flags tests ---

  // Helper for tests expecting program.error() to fire.
  // Uses exitOverride() so Commander throws instead of calling process.exit.
  // Validation errors happen before the infinite await, so the promise rejects immediately.
  async function startStreamExpectingError(
    args: string[],
  ): Promise<{ exitCode: number; message: string }> {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const program = new Command();
    program.option("--json", "Output as JSON");
    program.option("-p, --profile <name>", "Profile name");
    program.exitOverride();
    registerStream(program);
    try {
      await program.parseAsync(["node", "test", ...args]);
      throw new Error("Expected error but stream started");
    } catch (err: any) {
      stderrSpy.mockRestore();
      return { exitCode: err.exitCode ?? 1, message: err.message ?? String(err) };
    }
  }

  it("default gi flags enable case-insensitive matching", async () => {
    const ws = await startStream(["stream", "--pattern", "hello"]);

    ws.emit(
      "message",
      Buffer.from(makeJetstreamPost("did:plc:abc", "p1", "HELLO WORLD")),
    );
    expect(printStreamPost).toHaveBeenCalledTimes(1);
  });

  it("custom --pattern-flags override the default", async () => {
    const ws = await startStream([
      "stream",
      "--pattern",
      "hello",
      "--pattern-flags",
      "m",
    ]);

    // Without 'i' flag, should be case-sensitive
    ws.emit(
      "message",
      Buffer.from(makeJetstreamPost("did:plc:abc", "p1", "HELLO")),
    );
    expect(printStreamPost).not.toHaveBeenCalled();

    ws.emit(
      "message",
      Buffer.from(makeJetstreamPost("did:plc:abc", "p2", "hello")),
    );
    expect(printStreamPost).toHaveBeenCalledTimes(1);
  });

  it("errors when --pattern-flags is used without --pattern", async () => {
    const { exitCode, message } = await startStreamExpectingError([
      "stream",
      "--pattern-flags",
      "i",
    ]);
    expect(exitCode).toBe(1);
    expect(message).toContain("--pattern-flags requires --pattern");
  });

  it("errors on unknown regex flags", async () => {
    const { exitCode, message } = await startStreamExpectingError([
      "stream",
      "--pattern",
      "test",
      "--pattern-flags",
      "gx",
    ]);
    expect(exitCode).toBe(1);
    expect(message).toContain("unknown regex flag(s): x");
  });

  it("warns on duplicate flags, deduplicates, and continues", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});

    const ws = await startStream([
      "stream",
      "--pattern",
      "test",
      "--pattern-flags",
      "gig",
    ]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("duplicate regex flag(s) removed: g"),
    );

    // Stream should still work with deduplicated flags
    ws.emit(
      "message",
      Buffer.from(makeJetstreamPost("did:plc:abc", "p1", "test post")),
    );
    expect(printStreamPost).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it("errors when u and v flags are combined", async () => {
    const { exitCode, message } = await startStreamExpectingError([
      "stream",
      "--pattern",
      "test",
      "--pattern-flags",
      "uv",
    ]);
    expect(exitCode).toBe(1);
    expect(message).toContain("regex flags u and v cannot be used together");
  });

  it("warns when y and g flags are combined but continues", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});

    const ws = await startStream([
      "stream",
      "--pattern",
      "test",
      "--pattern-flags",
      "gy",
    ]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("sticky flag (y) makes global flag (g) meaningless"),
    );

    // Stream should still work
    ws.emit(
      "message",
      Buffer.from(makeJetstreamPost("did:plc:abc", "p1", "test post")),
    );
    expect(printStreamPost).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it("warns when u and d flags are combined but continues", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});

    const ws = await startStream([
      "stream",
      "--pattern",
      "test",
      "--pattern-flags",
      "ud",
    ]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unicode (u) with hasIndices (d) is valid but rarely needed"),
    );

    // Stream should still work
    expect(ws).toBeTruthy();

    warnSpy.mockRestore();
  });

  it("errors on invalid regex pattern syntax", async () => {
    const { exitCode, message } = await startStreamExpectingError([
      "stream",
      "--pattern",
      "[",
    ]);
    expect(exitCode).toBe(1);
    expect(message).toContain("invalid regex pattern");
  });

  it("resolves --handle to DID and sets wantedDids", async () => {
    mockAgent.getProfile.mockResolvedValue({
      data: { did: "did:plc:alice123" },
    });

    const ws = await startStream(["stream", "--handle", "alice.bsky.social"]);
    expect(MockWebSocket.lastUrl).toContain("wantedDids=did%3Aplc%3Aalice123");

    // When handle is known, it should be passed to printStreamPost
    ws.emit(
      "message",
      Buffer.from(
        makeJetstreamPost("did:plc:alice123", "p1", "my post"),
      ),
    );
    expect(printStreamPost).toHaveBeenCalledWith(
      "did:plc:alice123",
      "alice.bsky.social",
      "my post",
      "p1",
      "app.bsky.feed.post",
    );
  });
});
