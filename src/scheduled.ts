import { readFile, rename, stat, utimes, writeFile, readdir, unlink, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { bskyDir } from "@/config";
import type { ScheduledPost } from "@/lib/types";

export function scheduledDir(profile?: string): string {
  const base = bskyDir();
  return profile ? join(base, `scheduled-${profile}`) : join(base, "scheduled");
}

function scheduledPath(id: string, profile?: string): string {
  return join(scheduledDir(profile), `${id}.json`);
}

function claimPath(id: string, profile?: string): string {
  return join(scheduledDir(profile), `${id}.sending`);
}

/** A send can take this long, video and all, so a claim younger than this may still be in use. */
const STILL_SENDING_MS = 60 * 60_000;

function generateId(): string {
  const ts = Date.now();
  const rand = randomBytes(2).toString("hex");
  return `${ts}-${rand}`;
}

export async function isScheduledDirEmpty(profile?: string): Promise<boolean> {
  const dir = scheduledDir(profile);
  try {
    const files = await readdir(dir);
    return !files.some((f) => f.endsWith(".json"));
  } catch {
    return true;
  }
}

export async function saveScheduledPost(
  data: Omit<ScheduledPost, "id" | "createdAt">,
  profile?: string,
): Promise<ScheduledPost> {
  const id = generateId();
  const post: ScheduledPost = {
    ...data,
    id,
    createdAt: new Date().toISOString(),
  };
  const dir = scheduledDir(profile);
  await mkdir(dir, { recursive: true });
  await writeFile(scheduledPath(id, profile), JSON.stringify(post, null, "  ") + "\n", {
    mode: 0o644,
  });
  return post;
}

export async function loadScheduledPost(
  id: string,
  profile?: string,
): Promise<ScheduledPost> {
  const data = await readFile(scheduledPath(id, profile), "utf-8");
  return JSON.parse(data) as ScheduledPost;
}

export async function listScheduledPosts(profile?: string): Promise<ScheduledPost[]> {
  const dir = scheduledDir(profile);
  await mkdir(dir, { recursive: true });
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const posts: ScheduledPost[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const data = await readFile(join(dir, file), "utf-8");
      posts.push(JSON.parse(data) as ScheduledPost);
    } catch {
      // Skip corrupted files
    }
  }
  posts.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  return posts;
}

export async function deleteScheduledPost(
  id: string,
  profile?: string,
): Promise<void> {
  await unlink(scheduledPath(id, profile));
}

/**
 * Takes a post out of the queue before it's sent, so nothing can send it twice: not a
 * run that couldn't remove it afterwards, a kill mid-send, or another run at the same
 * moment. False if another run got there first. If this throws, don't send it.
 */
export async function claimScheduledPost(id: string, profile?: string): Promise<boolean> {
  try {
    await rename(scheduledPath(id, profile), claimPath(id, profile));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  // Renaming keeps the file's age, and unfinishedPosts goes by when it was taken.
  const now = new Date();
  await utimes(claimPath(id, profile), now, now).catch(() => {});
  return true;
}

/** It couldn't be sent, so back it goes. */
export async function releaseScheduledPost(id: string, profile?: string): Promise<void> {
  await rename(claimPath(id, profile), scheduledPath(id, profile));
}

export async function finishScheduledPost(id: string, profile?: string): Promise<void> {
  await unlink(claimPath(id, profile));
}

/** Posts a run took and never finished with, which may or may not have gone out. */
export async function unfinishedPosts(profile?: string): Promise<(ScheduledPost & { path: string })[]> {
  const dir = scheduledDir(profile);
  const files = await readdir(dir).catch(() => [] as string[]);
  const posts: (ScheduledPost & { path: string })[] = [];
  for (const file of files) {
    if (!file.endsWith(".sending")) continue;
    const path = join(dir, file);
    try {
      if (Date.now() - (await stat(path)).mtimeMs < STILL_SENDING_MS) continue;
      posts.push({ ...(JSON.parse(await readFile(path, "utf-8")) as ScheduledPost), path });
    } catch {
      // Gone since, or corrupted: there's nothing useful to say about it
    }
  }
  return posts;
}

export async function updateScheduledPost(
  post: ScheduledPost,
  profile?: string,
): Promise<void> {
  const dir = scheduledDir(profile);
  await mkdir(dir, { recursive: true });
  await writeFile(scheduledPath(post.id, profile), JSON.stringify(post, null, "  ") + "\n", {
    mode: 0o644,
  });
}
