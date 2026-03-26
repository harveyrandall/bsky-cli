import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock all external dependencies
vi.mock("@/scheduled", () => ({
  saveScheduledPost: vi.fn(),
  listScheduledPosts: vi.fn(),
  deleteScheduledPost: vi.fn(),
  updateScheduledPost: vi.fn(),
}));

vi.mock("@/drafts", () => ({
  saveDraft: vi.fn(),
}));

vi.mock("@/commands/post", () => ({
  createPost: vi.fn(),
}));

vi.mock("@/lib/date-prompt", () => ({
  promptDateTime: vi.fn(),
  formatLocalDateTime: vi.fn((iso: string) => `formatted:${iso}`),
}));

vi.mock("@/lib/split-thread", () => ({
  graphemeLength: vi.fn((text: string) => text.length),
}));

vi.mock("@/lib/format", () => ({
  outputJson: vi.fn(),
}));

vi.mock("@/index", () => ({
  getClient: vi.fn(),
  isJson: vi.fn(() => false),
}));

vi.mock("chalk", () => ({
  default: {
    blue: (s: string) => s,
    dim: (s: string) => s,
  },
}));

import {
  saveScheduledPost,
  listScheduledPosts,
  deleteScheduledPost,
  updateScheduledPost,
} from "@/scheduled";
import { saveDraft } from "@/drafts";
import { createPost } from "@/commands/post";
import { promptDateTime } from "@/lib/date-prompt";
import { getClient, isJson } from "@/index";
import { outputJson } from "@/lib/format";
import type { ScheduledPost } from "@/lib/types";

// Helper to create mock posts
function mockPost(overrides: Partial<ScheduledPost> = {}): ScheduledPost {
  return {
    id: "test-id",
    createdAt: "2026-03-26T12:00:00.000Z",
    scheduledAt: "2026-04-01T14:00:00.000Z",
    text: "Test post text",
    ...overrides,
  };
}

// We need to test the command handlers by importing and calling registerSchedule
// with a mock Commander program
import { Command } from "commander";
import { registerSchedule } from "./schedule";

describe("schedule list", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(isJson).mockReturnValue(false);
    program = new Command();
    program.option("-p, --profile <name>").option("--json");
    registerSchedule(program);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("reports no scheduled posts when empty", async () => {
    vi.mocked(listScheduledPosts).mockResolvedValue([]);

    await program.parseAsync(["node", "bsky", "schedule", "list"]);

    expect(errorSpy).toHaveBeenCalledWith("No scheduled posts.");
  });

  it("lists posts with 1-based indices", async () => {
    vi.mocked(listScheduledPosts).mockResolvedValue([
      mockPost({ id: "a", text: "First", scheduledAt: "2026-04-01T10:00:00.000Z" }),
      mockPost({ id: "b", text: "Second", scheduledAt: "2026-04-02T10:00:00.000Z" }),
    ]);

    await program.parseAsync(["node", "bsky", "schedule", "list"]);

    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("1."),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("2."),
    );
  });

  it("limits output to --number", async () => {
    vi.mocked(listScheduledPosts).mockResolvedValue([
      mockPost({ id: "a", text: "First" }),
      mockPost({ id: "b", text: "Second" }),
      mockPost({ id: "c", text: "Third" }),
    ]);

    await program.parseAsync(["node", "bsky", "schedule", "list", "-n", "2"]);

    expect(logSpy).toHaveBeenCalledTimes(2);
  });

  it("shows all with --all", async () => {
    const posts = Array.from({ length: 10 }, (_, i) =>
      mockPost({ id: `p${i}`, text: `Post ${i}` }),
    );
    vi.mocked(listScheduledPosts).mockResolvedValue(posts);

    await program.parseAsync(["node", "bsky", "schedule", "list", "-a"]);

    expect(logSpy).toHaveBeenCalledTimes(10);
  });

  it("reverses order with --order desc", async () => {
    vi.mocked(listScheduledPosts).mockResolvedValue([
      mockPost({ id: "a", text: "Sooner", scheduledAt: "2026-04-01T10:00:00.000Z" }),
      mockPost({ id: "b", text: "Later", scheduledAt: "2026-04-02T10:00:00.000Z" }),
    ]);

    await program.parseAsync(["node", "bsky", "schedule", "list", "-o", "desc"]);

    // First call should contain "Later" (reversed)
    const firstCall = logSpy.mock.calls[0][0] as string;
    expect(firstCall).toContain("Later");
  });

  it("outputs JSON when --json flag is set", async () => {
    vi.mocked(isJson).mockReturnValue(true);
    const posts = [mockPost({ id: "a" })];
    vi.mocked(listScheduledPosts).mockResolvedValue(posts);

    await program.parseAsync(["node", "bsky", "schedule", "list", "--json"]);

    expect(outputJson).toHaveBeenCalledWith(posts[0]);
  });

  it("shows attachment indicators", async () => {
    vi.mocked(listScheduledPosts).mockResolvedValue([
      mockPost({ images: ["/path/img1.jpg", "/path/img2.jpg"], video: "/path/vid.mp4" }),
    ]);

    await program.parseAsync(["node", "bsky", "schedule", "list"]);

    // Post line + image indicator + video indicator = 3 calls
    const allOutput = logSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(allOutput).toContain("2 image(s)");
    expect(allOutput).toContain("1 video");
  });
});

describe("schedule run", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(isJson).mockReturnValue(false);
    program = new Command();
    program.option("-p, --profile <name>").option("--json");
    registerSchedule(program);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("does nothing when no posts are due", async () => {
    // A post scheduled far in the future
    vi.mocked(listScheduledPosts).mockResolvedValue([
      mockPost({ scheduledAt: "2099-12-31T23:59:59.000Z" }),
    ]);

    await program.parseAsync(["node", "bsky", "schedule", "run"]);

    expect(getClient).not.toHaveBeenCalled();
    expect(createPost).not.toHaveBeenCalled();
  });

  it("posts due scheduled posts and deletes them", async () => {
    const duePost = mockPost({
      id: "due-1",
      scheduledAt: "2020-01-01T00:00:00.000Z", // in the past
      text: "Due post",
    });
    vi.mocked(listScheduledPosts).mockResolvedValue([duePost]);
    const mockAgent = {} as Awaited<ReturnType<typeof getClient>>;
    vi.mocked(getClient).mockResolvedValue(mockAgent);
    vi.mocked(createPost).mockResolvedValue({
      uri: "at://did:plc:test/app.bsky.feed.post/abc",
      cid: "cid123",
    });
    vi.mocked(deleteScheduledPost).mockResolvedValue(undefined);

    await program.parseAsync(["node", "bsky", "schedule", "run"]);

    expect(createPost).toHaveBeenCalledWith(mockAgent, "Due post", {
      images: undefined,
      imageAlts: undefined,
      video: undefined,
      videoAlt: undefined,
    });
    expect(deleteScheduledPost).toHaveBeenCalledWith("due-1", undefined);
    expect(logSpy).toHaveBeenCalledWith("at://did:plc:test/app.bsky.feed.post/abc");
  });

  it("continues on per-post failure and reports errors", async () => {
    const post1 = mockPost({ id: "fail-1", scheduledAt: "2020-01-01T00:00:00.000Z" });
    const post2 = mockPost({ id: "ok-2", scheduledAt: "2020-01-01T00:00:00.000Z", text: "Good post" });
    vi.mocked(listScheduledPosts).mockResolvedValue([post1, post2]);
    const mockAgent = {} as Awaited<ReturnType<typeof getClient>>;
    vi.mocked(getClient).mockResolvedValue(mockAgent);
    vi.mocked(createPost)
      .mockRejectedValueOnce(new Error("Network timeout"))
      .mockResolvedValueOnce({ uri: "at://ok", cid: "cid" });
    vi.mocked(deleteScheduledPost).mockResolvedValue(undefined);

    await program.parseAsync(["node", "bsky", "schedule", "run"]);

    expect(errorSpy).toHaveBeenCalledWith("Failed to post fail-1: Network timeout");
    expect(logSpy).toHaveBeenCalledWith("at://ok");
    // Only the successful post is deleted
    expect(deleteScheduledPost).toHaveBeenCalledTimes(1);
    expect(deleteScheduledPost).toHaveBeenCalledWith("ok-2", undefined);
  });
});
