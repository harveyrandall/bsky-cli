import { homedir } from "node:os";
import { basename, join } from "node:path";
import { maxImageBytes, maxImages, maxVideoBytes } from "@/lib/limits";
import { detectMimeType } from "@/lib/media";
import { tokenize } from "./commands";

type MediaKind = "image" | "video";

export interface StagedMedia {
  path: string;
  kind: MediaKind;
  alt?: string;
}

/** The filesystem, as far as checking a file goes. */
export interface MediaFs {
  /** undefined when there's no such file. */
  size(path: string): Promise<number | undefined>;
  /** The file's first bytes. */
  head(path: string): Promise<Uint8Array>;
}

const megabytes = (bytes: number) => `${bytes / 1_000_000} MB`;

function kindOf(mime: string): MediaKind | undefined {
  if (mime === "video/mp4") return "video";
  return mime.startsWith("image/") ? "image" : undefined;
}

/** What a file is, or why it can't be attached. */
export async function inspectMedia(path: string, fs: MediaFs): Promise<{ kind: MediaKind } | { error: string }> {
  const name = basename(path);
  const size = await fs.size(path);
  if (size === undefined) return { error: `${name} not found` };
  const kind = kindOf(detectMimeType(await fs.head(path)));
  if (!kind) return { error: `${name} isn't an image or MP4 video` };
  const limit = kind === "image" ? maxImageBytes() : maxVideoBytes();
  return size > limit ? { error: `${name} is over the ${megabytes(limit)} ${kind} limit` } : { kind };
}

/** Why `kind` can't join what's staged, if it can't. */
export function canStage(staged: readonly StagedMedia[], kind: MediaKind): string | undefined {
  if (staged.some((m) => m.kind !== kind)) return "A post can have images or one video, not both";
  if (kind === "video" && staged.length > 0) return "Only one video per post";
  if (kind === "image" && staged.length >= maxImages()) return `Only ${maxImages()} images per post`;
  return undefined;
}

const PATH_LIKE = /^(\/|~\/|\.\.?\/)/;

/** The paths in a drag-and-drop paste; undefined if it's anything else. */
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

export const expandHome = (path: string) => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
