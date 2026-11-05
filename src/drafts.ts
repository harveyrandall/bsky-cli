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

const isDraft = (value: unknown): value is Draft => {
  const d = value as Partial<Draft> | null;
  return typeof d?.id === "string" && typeof d.createdAt === "string" && typeof d.text === "string";
};

/** The drafts that can be used, and how many files can't. A folder that can't be read throws. */
export async function readDrafts(profile?: string): Promise<{ drafts: Draft[]; skipped: number }> {
  const dir = draftsDir(profile);
  await mkdir(dir, { recursive: true });
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { drafts: [], skipped: 0 };
    throw err;
  }
  const drafts: Draft[] = [];
  let skipped = 0;
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const draft: unknown = JSON.parse(await readFile(join(dir, file), "utf-8"));
      if (isDraft(draft)) drafts.push(draft);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  drafts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { drafts, skipped };
}

export async function listDrafts(profile?: string): Promise<Draft[]> {
  return (await readDrafts(profile)).drafts;
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
