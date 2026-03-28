import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock all external dependencies
vi.mock("@/scheduled", () => ({
  saveScheduledPost: vi.fn(),
  listScheduledPosts: vi.fn(),
  deleteScheduledPost: vi.fn(),
  updateScheduledPost: vi.fn(),
  isScheduledDirEmpty: vi.fn(() => false),
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

const mockCronStop = vi.fn();
vi.mock("croner", () => {
  const MockCron = vi.fn().mockImplementation(() => ({ stop: mockCronStop }));
  return { Cron: MockCron };
});

vi.mock("@/lib/scheduler", () => ({
  enableScheduler: vi.fn(),
  disableScheduler: vi.fn(),
  getSchedulerStatus: vi.fn(() => "not installed"),
  uninstallScheduler: vi.fn(),
}));

vi.mock("@/lib/recurrence", () => ({
  buildRRule: vi.fn((freq: string, count?: number) =>
    count != null ? `FREQ=MOCK;COUNT=${count}` : `FREQ=MOCK`,
  ),
  nextOccurrence: vi.fn(() => new Date("2026-04-02T14:00:00.000Z")),
  parseCount: vi.fn((input: string) => {
    const num = parseInt(input, 10);
    return isNaN(num) || num <= 0 ? null : num;
  }),
  parseRRuleFrequency: vi.fn(() => "daily"),
  formatFrequency: vi.fn(() => "every day"),
  VALID_FREQUENCIES: ["hourly", "daily", "fortnightly", "monthly", "annually"],
}));

const mockQuestion = vi.fn();
const mockRlClose = vi.fn();
vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({
    question: mockQuestion,
    close: mockRlClose,
  })),
}));

import {
  saveScheduledPost,
  listScheduledPosts,
  deleteScheduledPost,
  updateScheduledPost,
  isScheduledDirEmpty,
} from "@/scheduled";
import { saveDraft } from "@/drafts";
import { createPost } from "@/commands/post";
import { promptDateTime } from "@/lib/date-prompt";
import { getClient, isJson } from "@/index";
import { outputJson } from "@/lib/format";
import { Cron } from "croner";
import {
  enableScheduler,
  disableScheduler,
  getSchedulerStatus,
  uninstallScheduler,
} from "@/lib/scheduler";
import { buildRRule, nextOccurrence, parseCount } from "@/lib/recurrence";
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

describe("schedule watch", () => {
  let program: Command;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    program = new Command();
    program.option("-p, --profile <name>").option("--json");
    registerSchedule(program);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("creates a Cron job with default pattern and correct options", async () => {
    await program.parseAsync(["node", "bsky", "schedule", "watch"]);

    expect(Cron).toHaveBeenCalledWith(
      "* * * * *",
      { catch: true, protect: true },
      expect.any(Function),
    );
  });

  it("passes custom --interval to Cron", async () => {
    await program.parseAsync([
      "node", "bsky", "schedule", "watch", "--interval", "*/5 * * * *",
    ]);

    expect(Cron).toHaveBeenCalledWith(
      "*/5 * * * *",
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("prints startup message", async () => {
    await program.parseAsync(["node", "bsky", "schedule", "watch"]);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Watching for due scheduled posts"),
    );
  });
});

describe("schedule enable", () => {
  let program: Command;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    program = new Command();
    program.option("-p, --profile <name>").option("--json");
    registerSchedule(program);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("calls enableScheduler with default interval 1", async () => {
    await program.parseAsync(["node", "bsky", "schedule", "enable"]);
    expect(enableScheduler).toHaveBeenCalledWith(1, undefined);
  });

  it("calls enableScheduler with custom interval", async () => {
    await program.parseAsync([
      "node", "bsky", "schedule", "enable", "--interval", "5",
    ]);
    expect(enableScheduler).toHaveBeenCalledWith(5, undefined);
  });

  it("passes profile to enableScheduler", async () => {
    await program.parseAsync([
      "node", "bsky", "-p", "work", "schedule", "enable",
    ]);
    expect(enableScheduler).toHaveBeenCalledWith(1, "work");
  });
});

describe("schedule disable", () => {
  let program: Command;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    program = new Command();
    program.option("-p, --profile <name>").option("--json");
    registerSchedule(program);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("calls disableScheduler", async () => {
    await program.parseAsync(["node", "bsky", "schedule", "disable"]);
    expect(disableScheduler).toHaveBeenCalled();
  });

  it("prints confirmation message", async () => {
    await program.parseAsync(["node", "bsky", "schedule", "disable"]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Scheduler disabled"),
    );
  });
});

describe("schedule status", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(isJson).mockReturnValue(false);
    program = new Command();
    program.option("-p, --profile <name>").option("--json");
    registerSchedule(program);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("outputs 'not installed' state", async () => {
    vi.mocked(getSchedulerStatus).mockReturnValue("not installed");
    await program.parseAsync(["node", "bsky", "schedule", "status"]);
    expect(logSpy).toHaveBeenCalledWith("Scheduler: not installed");
  });

  it("outputs 'enabled' state", async () => {
    vi.mocked(getSchedulerStatus).mockReturnValue("enabled");
    await program.parseAsync(["node", "bsky", "schedule", "status"]);
    expect(logSpy).toHaveBeenCalledWith("Scheduler: enabled");
  });

  it("outputs 'disabled' state", async () => {
    vi.mocked(getSchedulerStatus).mockReturnValue("disabled");
    await program.parseAsync(["node", "bsky", "schedule", "status"]);
    expect(logSpy).toHaveBeenCalledWith("Scheduler: disabled");
  });

  it("outputs JSON when --json flag is set", async () => {
    vi.mocked(isJson).mockReturnValue(true);
    vi.mocked(getSchedulerStatus).mockReturnValue("enabled");
    await program.parseAsync(["node", "bsky", "schedule", "status", "--json"]);
    expect(outputJson).toHaveBeenCalledWith({ scheduler: "enabled" });
  });
});

describe("schedule uninstall", () => {
  let program: Command;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    program = new Command();
    program.option("-p, --profile <name>").option("--json");
    registerSchedule(program);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("reports not installed when scheduler is absent", async () => {
    vi.mocked(getSchedulerStatus).mockReturnValue("not installed");
    await program.parseAsync(["node", "bsky", "schedule", "uninstall"]);
    expect(errorSpy).toHaveBeenCalledWith("Scheduler is not installed.");
    expect(uninstallScheduler).not.toHaveBeenCalled();
  });
});

describe("schedule run with recurring posts", () => {
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

  it("mutates recurring post in place instead of deleting", async () => {
    const recurringPost = mockPost({
      id: "rec-1",
      scheduledAt: "2020-01-01T00:00:00.000Z",
      text: "Daily update",
      rrule: "FREQ=DAILY;COUNT=5",
      remainingCount: 3,
    });
    vi.mocked(listScheduledPosts).mockResolvedValue([recurringPost]);
    const mockAgent = {} as Awaited<ReturnType<typeof getClient>>;
    vi.mocked(getClient).mockResolvedValue(mockAgent);
    vi.mocked(createPost).mockResolvedValue({
      uri: "at://did:plc:test/app.bsky.feed.post/abc",
      cid: "cid123",
    });
    vi.mocked(updateScheduledPost).mockResolvedValue(undefined);

    await program.parseAsync(["node", "bsky", "schedule", "run"]);

    // Should update, not delete — RRULE COUNT updated in lockstep
    expect(updateScheduledPost).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "rec-1",
        scheduledAt: "2026-04-02T14:00:00.000Z",
        remainingCount: 2,
        rrule: "FREQ=MOCK;COUNT=2",
      }),
      undefined,
    );
    expect(deleteScheduledPost).not.toHaveBeenCalled();
  });

  it("mutates infinite recurring post without decrementing", async () => {
    const infinitePost = mockPost({
      id: "inf-1",
      scheduledAt: "2020-01-01T00:00:00.000Z",
      text: "Forever post",
      rrule: "FREQ=DAILY",
    });
    vi.mocked(listScheduledPosts).mockResolvedValue([infinitePost]);
    const mockAgent = {} as Awaited<ReturnType<typeof getClient>>;
    vi.mocked(getClient).mockResolvedValue(mockAgent);
    vi.mocked(createPost).mockResolvedValue({
      uri: "at://did:plc:test/app.bsky.feed.post/inf",
      cid: "cid789",
    });
    vi.mocked(updateScheduledPost).mockResolvedValue(undefined);

    await program.parseAsync(["node", "bsky", "schedule", "run"]);

    // Should update with new date but no remainingCount
    expect(updateScheduledPost).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "inf-1",
        scheduledAt: "2026-04-02T14:00:00.000Z",
        rrule: "FREQ=DAILY",
      }),
      undefined,
    );
    // remainingCount should not be set
    const updatedPost = vi.mocked(updateScheduledPost).mock.calls[0][0] as ScheduledPost;
    expect(updatedPost.remainingCount).toBeUndefined();
    expect(deleteScheduledPost).not.toHaveBeenCalled();
  });

  it("deletes recurring post on last occurrence", async () => {
    const lastPost = mockPost({
      id: "rec-last",
      scheduledAt: "2020-01-01T00:00:00.000Z",
      text: "Last one",
      rrule: "FREQ=DAILY;COUNT=5",
      remainingCount: 1,
    });
    vi.mocked(listScheduledPosts).mockResolvedValue([lastPost]);
    const mockAgent = {} as Awaited<ReturnType<typeof getClient>>;
    vi.mocked(getClient).mockResolvedValue(mockAgent);
    vi.mocked(createPost).mockResolvedValue({
      uri: "at://did:plc:test/app.bsky.feed.post/final",
      cid: "cid456",
    });
    vi.mocked(deleteScheduledPost).mockResolvedValue(undefined);

    await program.parseAsync(["node", "bsky", "schedule", "run"]);

    expect(deleteScheduledPost).toHaveBeenCalledWith("rec-last", undefined);
    expect(updateScheduledPost).not.toHaveBeenCalled();
  });
});

describe("schedule list with recurring posts", () => {
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

  it("shows recurrence info for recurring posts", async () => {
    vi.mocked(listScheduledPosts).mockResolvedValue([
      mockPost({
        rrule: "FREQ=DAILY;COUNT=5",
        remainingCount: 3,
      }),
    ]);

    await program.parseAsync(["node", "bsky", "schedule", "list"]);

    const allOutput = logSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(allOutput).toContain("Repeats");
    expect(allOutput).toContain("3 remaining");
  });

  it("shows 'forever' for infinite recurring posts", async () => {
    vi.mocked(listScheduledPosts).mockResolvedValue([
      mockPost({
        rrule: "FREQ=DAILY",
      }),
    ]);

    await program.parseAsync(["node", "bsky", "schedule", "list"]);

    const allOutput = logSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(allOutput).toContain("Repeats");
    expect(allOutput).toContain("forever");
  });
});

describe("schedule edit with recurrence", () => {
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

  it("displays recurrence info for recurring posts", async () => {
    vi.mocked(listScheduledPosts).mockResolvedValue([
      mockPost({
        rrule: "FREQ=DAILY;COUNT=5",
        remainingCount: 3,
      }),
    ]);
    // Choose "t" to edit text, provide new text
    mockQuestion
      .mockResolvedValueOnce("t")
      .mockResolvedValueOnce("Updated text");
    vi.mocked(updateScheduledPost).mockResolvedValue(undefined);

    await program.parseAsync(["node", "bsky", "schedule", "edit", "1"]);

    const allOutput = logSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(allOutput).toContain("Repeats:");
    expect(allOutput).toContain("3 remaining");
  });

  it("shows (r)ecurrence option for recurring posts", async () => {
    vi.mocked(listScheduledPosts).mockResolvedValue([
      mockPost({
        rrule: "FREQ=DAILY;COUNT=5",
        remainingCount: 3,
      }),
    ]);
    mockQuestion
      .mockResolvedValueOnce("t")
      .mockResolvedValueOnce("Updated text");
    vi.mocked(updateScheduledPost).mockResolvedValue(undefined);

    await program.parseAsync(["node", "bsky", "schedule", "edit", "1"]);

    // The prompt should include (r)ecurrence
    expect(mockQuestion).toHaveBeenCalledWith(
      expect.stringContaining("(r)ecurrence"),
    );
  });

  it("does not show (r)ecurrence option for one-shot posts", async () => {
    vi.mocked(listScheduledPosts).mockResolvedValue([mockPost()]);
    mockQuestion
      .mockResolvedValueOnce("t")
      .mockResolvedValueOnce("Updated text");
    vi.mocked(updateScheduledPost).mockResolvedValue(undefined);

    await program.parseAsync(["node", "bsky", "schedule", "edit", "1"]);

    // The prompt should include (b)oth, not (r)ecurrence
    expect(mockQuestion).toHaveBeenCalledWith(
      expect.stringContaining("(b)oth"),
    );
    expect(mockQuestion).not.toHaveBeenCalledWith(
      expect.stringContaining("(r)ecurrence"),
    );
  });

  it("allows editing recurrence frequency and count", async () => {
    vi.mocked(listScheduledPosts).mockResolvedValue([
      mockPost({
        rrule: "FREQ=DAILY;COUNT=5",
        remainingCount: 3,
      }),
    ]);
    // Choose "r" for recurrence, then provide new frequency and count
    mockQuestion
      .mockResolvedValueOnce("r")
      .mockResolvedValueOnce("monthly")
      .mockResolvedValueOnce("10");
    vi.mocked(updateScheduledPost).mockResolvedValue(undefined);

    await program.parseAsync(["node", "bsky", "schedule", "edit", "1"]);

    expect(buildRRule).toHaveBeenCalledWith("monthly", 10);
    expect(updateScheduledPost).toHaveBeenCalledWith(
      expect.objectContaining({
        remainingCount: 10,
      }),
      undefined,
    );
  });

  it("allows removing recurrence with 'none'", async () => {
    vi.mocked(listScheduledPosts).mockResolvedValue([
      mockPost({
        rrule: "FREQ=DAILY;COUNT=5",
        remainingCount: 3,
      }),
    ]);
    mockQuestion
      .mockResolvedValueOnce("r")
      .mockResolvedValueOnce("none");
    vi.mocked(updateScheduledPost).mockResolvedValue(undefined);

    await program.parseAsync(["node", "bsky", "schedule", "edit", "1"]);

    expect(updateScheduledPost).toHaveBeenCalledWith(
      expect.not.objectContaining({
        rrule: expect.anything(),
        remainingCount: expect.anything(),
      }),
      undefined,
    );
  });

  it("handles invalid frequency gracefully", async () => {
    vi.mocked(listScheduledPosts).mockResolvedValue([
      mockPost({
        rrule: "FREQ=DAILY;COUNT=5",
        remainingCount: 3,
      }),
    ]);
    mockQuestion
      .mockResolvedValueOnce("r")
      .mockResolvedValueOnce("invalid-freq");
    vi.mocked(updateScheduledPost).mockResolvedValue(undefined);

    await program.parseAsync(["node", "bsky", "schedule", "edit", "1"]);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid frequency"),
    );
    // Post should still be updated (other fields unchanged)
    expect(updateScheduledPost).toHaveBeenCalledWith(
      expect.objectContaining({
        rrule: "FREQ=DAILY;COUNT=5",
        remainingCount: 3,
      }),
      undefined,
    );
  });

  it("edits all fields including recurrence with 'a'", async () => {
    vi.mocked(listScheduledPosts).mockResolvedValue([
      mockPost({
        rrule: "FREQ=DAILY;COUNT=5",
        remainingCount: 3,
      }),
    ]);
    vi.mocked(promptDateTime).mockResolvedValue("2026-05-01T10:00:00.000Z");
    // Choose "a" for all, provide new text, then date handled by promptDateTime,
    // then frequency and count for recurrence
    mockQuestion
      .mockResolvedValueOnce("a")
      .mockResolvedValueOnce("Brand new text")
      .mockResolvedValueOnce("fortnightly")
      .mockResolvedValueOnce("6");
    vi.mocked(updateScheduledPost).mockResolvedValue(undefined);

    await program.parseAsync(["node", "bsky", "schedule", "edit", "1"]);

    expect(updateScheduledPost).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Brand new text",
        scheduledAt: "2026-05-01T10:00:00.000Z",
        remainingCount: 6,
      }),
      undefined,
    );
  });

  it("shows (r)ecurrence option for infinite recurring posts", async () => {
    vi.mocked(listScheduledPosts).mockResolvedValue([
      mockPost({ rrule: "FREQ=DAILY" }),
    ]);
    mockQuestion
      .mockResolvedValueOnce("t")
      .mockResolvedValueOnce("Updated text");
    vi.mocked(updateScheduledPost).mockResolvedValue(undefined);

    await program.parseAsync(["node", "bsky", "schedule", "edit", "1"]);

    expect(mockQuestion).toHaveBeenCalledWith(
      expect.stringContaining("(r)ecurrence"),
    );
    const allOutput = logSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(allOutput).toContain("forever");
  });

  it("allows setting recurrence to forever with blank count", async () => {
    vi.mocked(listScheduledPosts).mockResolvedValue([
      mockPost({
        rrule: "FREQ=DAILY;COUNT=5",
        remainingCount: 3,
      }),
    ]);
    // Choose "r", pick new frequency, leave count blank for forever
    mockQuestion
      .mockResolvedValueOnce("r")
      .mockResolvedValueOnce("hourly")
      .mockResolvedValueOnce("");
    vi.mocked(updateScheduledPost).mockResolvedValue(undefined);

    await program.parseAsync(["node", "bsky", "schedule", "edit", "1"]);

    expect(buildRRule).toHaveBeenCalledWith("hourly");
    const updatedPost = vi.mocked(updateScheduledPost).mock.calls[0][0] as ScheduledPost;
    expect(updatedPost.remainingCount).toBeUndefined();
    expect(updatedPost.rrule).toBe("FREQ=MOCK");
  });
});
