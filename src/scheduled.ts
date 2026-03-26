import { readFile, writeFile, readdir, unlink, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { bskyDir } from "@/config";
import type { ScheduledPost } from "@/lib/types";

function scheduledDir(profile?: string): string {
  const base = bskyDir();
  return profile ? join(base, `scheduled-${profile}`) : join(base, "scheduled");
}

function scheduledPath(id: string, profile?: string): string {
  return join(scheduledDir(profile), `${id}.json`);
}

function generateId(): string {
  const ts = Date.now();
  const rand = randomBytes(2).toString("hex");
  return `${ts}-${rand}`;
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
