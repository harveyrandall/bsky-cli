import { readFile, writeFile, readdir, unlink, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { bskyDir } from "@/config";
import type { Draft } from "@/lib/types";

function draftsDir(profile?: string): string {
  const base = bskyDir();
  return profile ? join(base, `drafts-${profile}`) : join(base, "drafts");
}

function draftPath(id: string, profile?: string): string {
  return join(draftsDir(profile), `${id}.json`);
}

function generateId(): string {
  const ts = Date.now();
  const rand = randomBytes(2).toString("hex");
  return `${ts}-${rand}`;
}

export async function saveDraft(
  data: Omit<Draft, "id" | "createdAt">,
  profile?: string,
): Promise<Draft> {
  const id = generateId();
  const draft: Draft = {
    ...data,
    id,
    createdAt: new Date().toISOString(),
  };
  const dir = draftsDir(profile);
  await mkdir(dir, { recursive: true });
  await writeFile(draftPath(id, profile), JSON.stringify(draft, null, "  ") + "\n", {
    mode: 0o644,
  });
  return draft;
}

export async function loadDraft(
  id: string,
  profile?: string,
): Promise<Draft> {
  const data = await readFile(draftPath(id, profile), "utf-8");
  return JSON.parse(data) as Draft;
}

export async function listDrafts(profile?: string): Promise<Draft[]> {
  const dir = draftsDir(profile);
  await mkdir(dir, { recursive: true });
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const drafts: Draft[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const data = await readFile(join(dir, file), "utf-8");
      drafts.push(JSON.parse(data) as Draft);
    } catch {
      // Skip corrupted files
    }
  }
  drafts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return drafts;
}

export async function deleteDraft(
  id: string,
  profile?: string,
): Promise<void> {
  await unlink(draftPath(id, profile));
}

export async function resolveDraftId(
  partial: string,
  profile?: string,
): Promise<string> {
  const drafts = await listDrafts(profile);
  const matches = drafts.filter((d) => d.id.startsWith(partial));
  if (matches.length === 0) {
    throw new Error(`No draft found matching "${partial}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous draft ID "${partial}" — matches ${matches.length} drafts. Be more specific.`,
    );
  }
  return matches[0].id;
}
