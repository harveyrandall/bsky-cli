import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimScheduledPost,
  claimedPosts,
  finishScheduledPost,
  listScheduledPosts,
  releaseScheduledPost,
  rescheduleScheduledPost,
  saveScheduledPost,
  scheduledDir,
  updateScheduledPost,
} from "@/scheduled";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, utimes: vi.fn(fs.utimes) };
});

describe("taking a post out of the queue to send it", () => {
  let home: string;
  const saved = () => saveScheduledPost({ scheduledAt: "2020-01-01T00:00:00.000Z", text: "hello" });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bsky-claim-"));
    vi.stubEnv("XDG_CONFIG_HOME", home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("takes it out of the queue, so no run can send it again", async () => {
    const post = await saved();
    await expect(claimScheduledPost(post)).resolves.toMatchObject({ id: post.id });
    await expect(listScheduledPosts()).resolves.toEqual([]);
  });
  it("goes to one run only, when two get there together", async () => {
    const post = await saved();
    const claims = await Promise.all([claimScheduledPost(post), claimScheduledPost(post)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
  it("hands back what's in the file, not what was listed", async () => {
    const post = await saved();
    await expect(claimScheduledPost({ ...post, text: "out of date" })).resolves.toMatchObject({ text: "hello" });
  });
  it("leaves a post that's moved on since it was listed, as that's its next run", async () => {
    const post = await saved();
    await expect(claimScheduledPost({ ...post, scheduledAt: "2019-01-01T00:00:00.000Z" })).resolves.toBeUndefined();
    await expect(listScheduledPosts()).resolves.toHaveLength(1);
  });
  it("still takes a post if it can't date the claim", async () => {
    const post = await saved();
    vi.mocked(utimes).mockRejectedValueOnce(new Error("EPERM"));
    await expect(claimScheduledPost(post)).resolves.toBeDefined();
  });
  it.skipIf(process.getuid?.() === 0)("fails if it can't be taken, so the post isn't sent", async () => {
    const post = await saved();
    chmodSync(scheduledDir(), 0o500);
    try {
      await expect(claimScheduledPost(post)).rejects.toThrow();
    } finally {
      chmodSync(scheduledDir(), 0o700);
    }
    await expect(listScheduledPosts()).resolves.toHaveLength(1);
  });
  it("goes back in the queue if it couldn't be sent", async () => {
    const post = await saved();
    await claimScheduledPost(post);
    await releaseScheduledPost(post.id);
    await expect(listScheduledPosts()).resolves.toMatchObject([{ id: post.id }]);
  });
  it("is gone once it's finished with", async () => {
    const post = await saved();
    await claimScheduledPost(post);
    await finishScheduledPost(post.id);
    expect(readdirSync(scheduledDir())).toEqual([]);
  });
  it("comes back as its next run, with no moment both files exist", async () => {
    const post = await saved();
    await claimScheduledPost(post);
    await rescheduleScheduledPost({ ...post, scheduledAt: "2020-01-02T00:00:00.000Z" });
    expect(readdirSync(scheduledDir())).toEqual([`${post.id}.json`]);
    await expect(listScheduledPosts()).resolves.toMatchObject([{ scheduledAt: "2020-01-02T00:00:00.000Z" }]);
  });
  it("leaves the claim as it was if its next run can't be written", async () => {
    const post = await saved();
    await claimScheduledPost(post);
    mkdirSync(join(scheduledDir(), `${post.id}.next`));
    await expect(rescheduleScheduledPost({ ...post, scheduledAt: "2020-01-02T00:00:00.000Z" })).rejects.toThrow();
    await expect(claimedPosts()).resolves.toMatchObject([{ id: post.id, text: "hello" }]);
  });
  it("won't bring a post back by editing it while it's being sent", async () => {
    const post = await saved();
    await claimScheduledPost(post);
    await expect(updateScheduledPost({ ...post, text: "edited" })).rejects.toMatchObject({ code: "ENOENT" });
    await expect(listScheduledPosts()).resolves.toEqual([]);
  });
  it("replaces all of a post when editing, shorter or not", async () => {
    const post = await saved();
    await updateScheduledPost({ id: post.id, createdAt: post.createdAt, scheduledAt: post.scheduledAt, text: "x" });
    await expect(listScheduledPosts()).resolves.toMatchObject([{ text: "x" }]);
  });
  it("isn't taken for a post waiting in the queue", async () => {
    const post = await saved();
    const old = new Date(Date.now() - 500 * 60_000);
    utimesSync(join(scheduledDir(), `${post.id}.json`), old, old);
    await expect(claimedPosts()).resolves.toEqual([]);
  });
  it("goes by when it was taken, not when it was written", async () => {
    const post = await saved();
    const old = new Date(Date.now() - 500 * 60_000);
    utimesSync(join(scheduledDir(), `${post.id}.json`), old, old);
    await claimScheduledPost(post);
    await expect(claimedPosts()).resolves.toMatchObject([{ stale: false }]);
  });
  it("finds nothing in a folder that isn't there", async () => {
    expect(existsSync(scheduledDir())).toBe(false);
    await expect(claimedPosts()).resolves.toEqual([]);
  });
});
