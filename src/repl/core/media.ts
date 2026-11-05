import { readdirSync, statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { maxImageBytes, maxImages, maxVideoBytes } from "@/lib/limits";
import { detectMimeType, isMp4 } from "@/lib/media";
import { tokenize } from "./commands";

type MediaKind = "image" | "video";

export interface StagedMedia {
  path: string;
  kind: MediaKind;
  alt?: string;
}

/** The filesystem, as far as checking a file goes. */
export interface MediaFs {
  /** undefined when there's no such file; anything else wrong throws. */
  size(path: string): Promise<number | undefined>;
  /** The file's first bytes. */
  head(path: string): Promise<Uint8Array>;
}

export const nodeMediaFs: MediaFs = {
  async size(path) {
    const found = await stat(path).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return undefined;
      throw err;
    });
    if (found?.isDirectory()) throw new Error("is a folder");
    return found?.size;
  },
  async head(path) {
    const file = await open(path);
    try {
      const { buffer } = await file.read(Buffer.alloc(12), 0, 12, 0);
      return buffer;
    } finally {
      await file.close();
    }
  },
};

const megabytes = (bytes: number) => `${bytes / 1_000_000} MB`;

function kindOf(head: Uint8Array): MediaKind | undefined {
  if (detectMimeType(head).startsWith("image/")) return "image";
  return isMp4(head) ? "video" : undefined;
}

/** What a file is, and why it can't be attached if it can't. */
export async function inspectMedia(path: string, fs: MediaFs): Promise<{ kind?: MediaKind; error?: string }> {
  const name = basename(path);
  try {
    const size = await fs.size(path);
    if (size === undefined) return { error: `${name} not found` };
    const kind = kindOf(await fs.head(path));
    if (!kind) return { error: `${name} isn't an image or MP4 video` };
    const limit = kind === "image" ? maxImageBytes() : maxVideoBytes();
    return size > limit ? { kind, error: `${name} is over the ${megabytes(limit)} ${kind} limit` } : { kind };
  } catch (err) {
    return { error: `${name}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Why `kind` can't join what's staged, if it can't. */
export function canStage(staged: readonly StagedMedia[], kind: MediaKind): string | undefined {
  if (staged.some((m) => m.kind !== kind)) return "A post can have images or one video, not both";
  if (kind === "video" && staged.length > 0) return "Only one video per post";
  if (kind === "image" && staged.length >= maxImages()) return `Only ${maxImages()} images per post`;
  return undefined;
}

// Not //host/…: on Windows, checking a pasted network path would connect to it.
const PATH_LIKE = /^(\/(?!\/)|~\/|\.\.?\/)/;

/** The tokens of a paste, if they're all shaped like paths. Doesn't check that they exist. */
export function parseDroppedPaths(text: string): string[] | undefined {
  try {
    const tokens = tokenize(text);
    return tokens.length > 0 && tokens.every((t) => PATH_LIKE.test(t)) ? tokens : undefined;
  } catch {
    return undefined; // an unclosed quote: text, not paths
  }
}

export function chips(staged: readonly StagedMedia[]): string {
  return `📎 ${staged.map((m) => basename(m.path)).join(" · ")}`;
}

/** Media as `createPost` and drafts take it; no alt text falls back to the file name, as `createPost` does. */
export function mediaOptions(media: readonly StagedMedia[] = []) {
  const images = media.filter((m) => m.kind === "image");
  const video = media.find((m) => m.kind === "video");
  return {
    ...(images.length > 0 && { images: images.map((m) => m.path), imageAlts: images.map((m) => m.alt ?? basename(m.path)) }),
    ...(video && { video: video.path, videoAlt: video.alt ?? basename(video.path) }),
  };
}

export const expandHome = (path: string) => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false; // a link that goes nowhere is just a name
  }
}

/** For Tab: what `partial` could be, as typed, with folders ending in `/`. */
export function pathMatches(partial: string): string[] {
  const at = partial.lastIndexOf("/") + 1;
  const [dir, base] = [partial.slice(0, at), partial.slice(at)];
  const folder = expandHome(dir || ".");
  try {
    return readdirSync(folder)
      .filter((name) => name.startsWith(base) && (base.startsWith(".") || !name.startsWith(".")))
      .sort()
      .map((name) => `${dir}${name}${isFolder(join(folder, name)) ? "/" : ""}`);
  } catch {
    return []; // nothing to offer: the folder isn't there, or can't be read
  }
}
