import { open, readFile, rename, stat, utimes, writeFile, readdir, unlink, mkdir } from "node:fs/promises";
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

export function claimPath(id: string, profile?: string): string {
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
 * Takes a post out of the queue before it's sent, so that overlapping runs, a run that
 * can't remove it afterwards and a kill mid-send can't send it again by themselves.
 * Gives back what's in the file, or nothing if there's nothing to send: another run got
 * there first, or a recurring post has moved on to its next run, which comes back under
 * the same id. If this throws, don't send it.
 */
export async function claimScheduledPost(listed: ScheduledPost, profile?: string): Promise<ScheduledPost | undefined> {
  const path = claimPath(listed.id, profile);
  try {
    await rename(scheduledPath(listed.id, profile), path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  // Renaming keeps the file's age, and claimedPosts goes by when it was taken.
  const now = new Date();
  await utimes(path, now, now).catch(() => {});
  const claimed = JSON.parse(await readFile(path, "utf-8")) as ScheduledPost;
  if (claimed.scheduledAt === listed.scheduledAt) return claimed;
  await releaseScheduledPost(listed.id, profile);
  return undefined;
}

/** It couldn't be sent, so back it goes. */
export async function releaseScheduledPost(id: string, profile?: string): Promise<void> {
  await rename(claimPath(id, profile), scheduledPath(id, profile));
}

export async function finishScheduledPost(id: string, profile?: string): Promise<void> {
  await unlink(claimPath(id, profile));
}

/**
 * Puts a recurring post back as its next run. It's written over the claim first, so its
 * two files never exist at once, which would let another run's claim replace this one.
 */
export async function rescheduleScheduledPost(post: ScheduledPost, profile?: string): Promise<void> {
  const next = join(scheduledDir(profile), `${post.id}.next`);
  try {
    await writeFile(next, JSON.stringify(post, null, "  ") + "\n", { mode: 0o644 });
    await rename(next, claimPath(post.id, profile));
  } catch (err) {
    await unlink(next).catch(() => {});
    throw err;
  }
  await rename(claimPath(post.id, profile), scheduledPath(post.id, profile));
}

export interface ClaimedPost {
  id: string;
  path: string;
  /** Old enough that the run sending it has probably stopped, so it may or may not have gone. */
  stale: boolean;
  /** Undefined if the file can't be read. */
  text?: string;
  rrule?: string;
}

/** Posts taken from the queue and not finished with. */
export async function claimedPosts(profile?: string): Promise<ClaimedPost[]> {
  const dir = scheduledDir(profile);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const posts: ClaimedPost[] = [];
  for (const file of files) {
    if (!file.endsWith(".sending")) continue;
    const path = join(dir, file);
    const age = await stat(path).then((s) => Math.abs(Date.now() - s.mtimeMs)).catch(() => undefined);
    if (age === undefined) continue; // finished with since
    const post = await readFile(path, "utf-8").then((data) => JSON.parse(data) as Partial<ScheduledPost> | null).catch(() => null);
    posts.push({
      id: file.slice(0, -".sending".length),
      path,
      stale: age >= STILL_SENDING_MS,
      text: typeof post?.text === "string" ? post.text : undefined,
      rrule: post?.rrule,
    });
  }
  return posts;
}

/** Only over a post that's still queued: this mustn't bring back one being sent. */
export async function updateScheduledPost(
  post: ScheduledPost,
  profile?: string,
): Promise<void> {
  const file = await open(scheduledPath(post.id, profile), "r+");
  try {
    await file.truncate();
    await file.writeFile(JSON.stringify(post, null, "  ") + "\n");
  } finally {
    await file.close();
  }
}
