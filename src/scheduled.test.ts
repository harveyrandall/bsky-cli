import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  readdir: vi.fn(),
  unlink: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock("node:crypto", () => ({
  randomBytes: vi.fn(() => Buffer.from([0xa7, 0xf3])),
}));

vi.mock("@/config", () => ({
  bskyDir: vi.fn(() => "/mock/bsky-cli"),
}));

import { readFile, writeFile, readdir, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  saveScheduledPost,
  loadScheduledPost,
  listScheduledPosts,
  deleteScheduledPost,
  updateScheduledPost,
} from "./scheduled";

const mockBase = "/mock/bsky-cli";
const defaultScheduledDir = join(mockBase, "scheduled");

describe("saveScheduledPost", () => {
  beforeEach(() => vi.clearAllMocks());

  it("generates ID and writes JSON file", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1741392000000);
    (mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const post = await saveScheduledPost({
      scheduledAt: "2026-04-01T14:00:00.000Z",
      text: "Hello future",
    });

    expect(post.id).toBe("1741392000000-a7f3");
    expect(post.text).toBe("Hello future");
    expect(post.scheduledAt).toBe("2026-04-01T14:00:00.000Z");
    expect(post.createdAt).toBeDefined();
    expect(mkdir).toHaveBeenCalledWith(defaultScheduledDir, { recursive: true });
    expect(writeFile).toHaveBeenCalledWith(
      join(defaultScheduledDir, "1741392000000-a7f3.json"),
      expect.stringContaining('"Hello future"'),
      { mode: 0o644 },
    );
  });

  it("uses profile-scoped directory when profile is provided", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1741392000000);
    (mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await saveScheduledPost(
      { scheduledAt: "2026-04-01T14:00:00.000Z", text: "test" },
      "work",
    );

    expect(mkdir).toHaveBeenCalledWith(
      join(mockBase, "scheduled-work"),
      { recursive: true },
    );
  });
});

describe("loadScheduledPost", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads and parses a scheduled post file", async () => {
    const mockPost = {
      id: "1741392000000-a7f3",
      createdAt: "2026-03-26T12:00:00.000Z",
      scheduledAt: "2026-04-01T14:00:00.000Z",
      text: "Hello",
    };
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify(mockPost),
    );

    const post = await loadScheduledPost("1741392000000-a7f3");
    expect(post).toEqual(mockPost);
    expect(readFile).toHaveBeenCalledWith(
      join(defaultScheduledDir, "1741392000000-a7f3.json"),
      "utf-8",
    );
  });
});

describe("listScheduledPosts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns empty array when no posts exist", async () => {
    (mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (readdir as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const posts = await listScheduledPosts();
    expect(posts).toEqual([]);
  });

  it("reads all JSON files and sorts by scheduledAt", async () => {
    (mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
      "b.json",
      "a.json",
      "readme.txt",
    ]);

    const postA = {
      id: "a",
      createdAt: "2026-03-26T12:00:00.000Z",
      scheduledAt: "2026-04-01T10:00:00.000Z",
      text: "earlier",
    };
    const postB = {
      id: "b",
      createdAt: "2026-03-26T11:00:00.000Z",
      scheduledAt: "2026-04-02T10:00:00.000Z",
      text: "later",
    };

    (readFile as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(JSON.stringify(postB))
      .mockResolvedValueOnce(JSON.stringify(postA));

    const posts = await listScheduledPosts();
    expect(posts).toHaveLength(2);
    expect(posts[0].id).toBe("a"); // earlier scheduledAt comes first
    expect(posts[1].id).toBe("b");
  });

  it("skips corrupted files", async () => {
    (mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (readdir as ReturnType<typeof vi.fn>).mockResolvedValue(["bad.json"]);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue("not valid json{{{");

    const posts = await listScheduledPosts();
    expect(posts).toEqual([]);
  });
});

describe("deleteScheduledPost", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removes the scheduled post file", async () => {
    (unlink as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await deleteScheduledPost("1741392000000-a7f3");

    expect(unlink).toHaveBeenCalledWith(
      join(defaultScheduledDir, "1741392000000-a7f3.json"),
    );
  });

  it("uses profile-scoped path", async () => {
    (unlink as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await deleteScheduledPost("1741392000000-a7f3", "work");

    expect(unlink).toHaveBeenCalledWith(
      join(mockBase, "scheduled-work", "1741392000000-a7f3.json"),
    );
  });
});

describe("updateScheduledPost", () => {
  beforeEach(() => vi.clearAllMocks());

  it("overwrites the existing file with updated data", async () => {
    (mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const post = {
      id: "1741392000000-a7f3",
      createdAt: "2026-03-26T12:00:00.000Z",
      scheduledAt: "2026-05-01T14:00:00.000Z",
      text: "Updated text",
    };

    await updateScheduledPost(post);

    expect(writeFile).toHaveBeenCalledWith(
      join(defaultScheduledDir, "1741392000000-a7f3.json"),
      expect.stringContaining('"Updated text"'),
      { mode: 0o644 },
    );
  });

  it("uses profile-scoped path", async () => {
    (mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await updateScheduledPost(
      {
        id: "test-id",
        createdAt: "2026-03-26T12:00:00.000Z",
        scheduledAt: "2026-05-01T14:00:00.000Z",
        text: "test",
      },
      "work",
    );

    expect(mkdir).toHaveBeenCalledWith(
      join(mockBase, "scheduled-work"),
      { recursive: true },
    );
  });
});
