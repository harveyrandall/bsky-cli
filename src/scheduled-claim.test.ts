import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimScheduledPost,
  finishScheduledPost,
  listScheduledPosts,
  releaseScheduledPost,
  saveScheduledPost,
  scheduledDir,
  unfinishedPosts,
} from "@/scheduled";

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
    const { id } = await saved();
    await expect(claimScheduledPost(id)).resolves.toBe(true);
    await expect(listScheduledPosts()).resolves.toEqual([]);
  });
  it("goes to one run only, when two get there together", async () => {
    const { id } = await saved();
    const claims = await Promise.all([claimScheduledPost(id), claimScheduledPost(id)]);
    expect(claims.sort()).toEqual([false, true]);
  });
  it.skipIf(process.getuid?.() === 0)("fails if it can't be taken, so the post isn't sent", async () => {
    const { id } = await saved();
    chmodSync(scheduledDir(), 0o500);
    try {
      await expect(claimScheduledPost(id)).rejects.toThrow();
    } finally {
      chmodSync(scheduledDir(), 0o700);
    }
    await expect(listScheduledPosts()).resolves.toHaveLength(1);
  });
  it("goes back in the queue if it couldn't be sent", async () => {
    const { id } = await saved();
    await claimScheduledPost(id);
    await releaseScheduledPost(id);
    await expect(listScheduledPosts()).resolves.toMatchObject([{ id }]);
  });
  it("is gone once it's finished with", async () => {
    const { id } = await saved();
    await claimScheduledPost(id);
    await finishScheduledPost(id);
    expect(readdirSync(scheduledDir())).toEqual([]);
  });

  describe("and never finishing", () => {
    const abandoned = async (minutesAgo: number) => {
      const { id } = await saved();
      await claimScheduledPost(id);
      const then = new Date(Date.now() - minutesAgo * 60_000);
      utimesSync(join(scheduledDir(), `${id}.sending`), then, then);
      return id;
    };
    it("is reported, as it may or may not have gone", async () => {
      const id = await abandoned(120);
      await expect(unfinishedPosts()).resolves.toMatchObject([{ id, text: "hello" }]);
    });
    it("isn't reported while another run may still be sending it", async () => {
      await abandoned(5);
      await expect(unfinishedPosts()).resolves.toEqual([]);
    });
    it("goes by when it was taken, not when it was written", async () => {
      const { id } = await saved();
      const old = new Date(Date.now() - 500 * 60_000);
      utimesSync(join(scheduledDir(), `${id}.json`), old, old);
      await claimScheduledPost(id);
      await expect(unfinishedPosts()).resolves.toEqual([]);
    });
    it("finds nothing in a folder that isn't there", async () => {
      expect(existsSync(scheduledDir())).toBe(false);
      await expect(unfinishedPosts()).resolves.toEqual([]);
    });
  });
});
