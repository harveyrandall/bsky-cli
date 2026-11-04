import { isAbsolute } from "node:path";
import { canStage, type StagedMedia } from "./media";
import type { Markers } from "./markers";
import type { Unsent } from "./pipeline";
import type { RegistryEntry } from "./refs";
import type { ReplSettings } from "./repl";
import {
  isAtUri,
  isCid,
  isCooldown,
  isDid,
  isHandle,
  isIsoUtc,
  isMarker,
  isOwnLabel,
  isRkey,
  isSessionId,
  type Did,
  type Handle,
  type IsoUtc,
  type OwnLabel,
  type SessionId,
  type StrongRef,
  type ThreadLetter,
} from "./types";

type ReturnTo = "idle" | "thread";

/** The mode, with a target as its label: the registry knows the rest. */
export type SavedMode =
  | { kind: "idle" | "thread" }
  | { kind: "reply-once" | "quote-once"; target: OwnLabel; returnTo: ReturnTo }
  | { kind: "post-once" | "schedule-once" | "draft-once"; returnTo: ReturnTo };

/** Spec §12. Tokens are never saved; the profile's session file handles auth. */
export interface ReplSessionFile {
  version: 1;
  id: SessionId;
  createdAt: IsoUtc;
  updatedAt: IsoUtc;
  handle: Handle;
  did: Did;
  profile?: string;
  settings: ReplSettings & { markers: Markers };
  posts: RegistryEntry[];
  /** `#n` labels, which arrive with viewing posts. */
  viewed: never[];
  thread?: { root: StrongRef; cursor: StrongRef; letter?: ThreadLetter; count: number };
  mode: SavedMode;
  composer: { text: string; cursor: number };
  staged: StagedMedia[];
  pending: Unsent[];
  history: string[];
  counters: { nextLabel: number; nextViewed: number; nextLetter: number };
}

type Fields = Record<string, unknown>;

const isObject = (v: unknown): v is Fields => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
const isRef = (v: unknown) => isObject(v) && isAtUri(v.uri) && isCid(v.cid);
const isTarget = (v: unknown) => isObject(v) && isRef(v.parent) && isRef(v.root);
const isLetter = (v: unknown) => typeof v === "string" && /^[A-Z]{1,3}$/.test(v);
const isReturnTo = (v: unknown) => v === "idle" || v === "thread";
const optional = (v: unknown, ok: (v: unknown) => boolean) => v === undefined || ok(v);

function need(ok: unknown, field: string): asserts ok {
  if (!ok) throw new Error(`Session file: bad ${field}`);
}

function checkSettings(s: unknown): void {
  need(isObject(s), "settings");
  for (const key of ["autoThread", "prefixThread", "verbose", "forceAlt", "askToSave"]) {
    need(typeof s[key] === "boolean", `settings.${key}`);
  }
  need(s.threadLabel === false || s.threadLabel === "append" || s.threadLabel === "prepend", "settings.threadLabel");
  need(optional(s.undo, isCooldown), "settings.undo");
  need(optional(s.pace, isCooldown), "settings.pace");
  need(isObject(s.markers), "settings.markers");
  for (const key of ["split", "send", "cut"]) need(isMarker(s.markers[key]), `settings.markers.${key}`);
}

function checkEntry(e: unknown, at: string): void {
  need(isObject(e), at);
  need(isOwnLabel(e.label), `${at}.label`);
  need(isAtUri(e.uri), `${at}.uri`);
  need(isCid(e.cid), `${at}.cid`);
  need(isRkey(e.rkey), `${at}.rkey`);
  need(isDid(e.authorDid), `${at}.authorDid`);
  need(isRef(e.root), `${at}.root`);
  need(optional(e.parent, isAtUri), `${at}.parent`);
  need(typeof e.excerpt === "string", `${at}.excerpt`);
  need(optional(e.notes, (v) => typeof v === "string"), `${at}.notes`);
  need(optional(e.external, isHandle), `${at}.external`);
  need(optional(e.letter, isLetter), `${at}.letter`);
}

function checkMode(m: unknown): void {
  need(isObject(m), "mode");
  if (m.kind === "idle" || m.kind === "thread") return;
  need(["reply-once", "quote-once", "post-once", "schedule-once", "draft-once"].includes(m.kind as string), "mode.kind");
  need(isReturnTo(m.returnTo), "mode.returnTo");
  if (m.kind === "reply-once" || m.kind === "quote-once") need(isOwnLabel(m.target), "mode.target");
}

/** Each file is checked, and then whether a post could hold them all. */
function checkMedia(media: unknown, at: string): void {
  need(Array.isArray(media), at);
  const seen: StagedMedia[] = [];
  media.forEach((m: unknown, i) => {
    need(isObject(m), `${at}[${i}]`);
    need(m.kind === "image" || m.kind === "video", `${at}[${i}].kind`);
    need(typeof m.path === "string" && isAbsolute(m.path), `${at}[${i}].path`);
    need(optional(m.alt, (v) => typeof v === "string"), `${at}[${i}].alt`);
    need(canStage(seen, m.kind) === undefined, at);
    seen.push(m as unknown as StagedMedia);
  });
}

function checkIntent(intent: unknown, at: string): void {
  need(isObject(intent), at);
  if (intent.kind === "thread" || intent.kind === "standalone") return;
  need(intent.kind === "reply" || intent.kind === "quote", at);
  need(isRef(intent.target), at);
  if (intent.kind === "reply") need(isRef(intent.root), at);
}

function checkItem(item: unknown, at: string): void {
  need(isObject(item), at);
  need(isCount(item.id), `${at}.id`);
  checkIntent(item.intent, `${at}.intent`);
  need(Array.isArray(item.posts) && item.posts.length > 0 && item.posts.every((p) => typeof p === "string"), `${at}.posts`);
  need(typeof item.createdAt === "number", `${at}.createdAt`);
  need(optional(item.target, isTarget), `${at}.target`);
  if (item.media !== undefined) checkMedia(item.media, `${at}.media`);
  if ((item.intent as Fields).kind === "quote") need(item.posts.length === 1 && item.media === undefined, at);
}

/** Every field, or an error naming the first bad one: a file is never loaded half-valid. */
export function parseSessionFile(raw: unknown): ReplSessionFile {
  need(isObject(raw), "file");
  need(raw.version === 1, "version");
  need(isSessionId(raw.id), "id");
  need(isIsoUtc(raw.createdAt), "createdAt");
  need(isIsoUtc(raw.updatedAt), "updatedAt");
  need(isHandle(raw.handle), "handle");
  need(isDid(raw.did), "did");
  need(optional(raw.profile, (v) => typeof v === "string"), "profile");
  checkSettings(raw.settings);
  need(Array.isArray(raw.posts), "posts");
  raw.posts.forEach((e, i) => checkEntry(e, `posts[${i}]`));
  need(Array.isArray(raw.viewed), "viewed");
  if (raw.thread !== undefined) {
    const t = raw.thread;
    need(isObject(t), "thread");
    need(isRef(t.root), "thread.root");
    need(isRef(t.cursor), "thread.cursor");
    need(optional(t.letter, isLetter), "thread.letter");
    need(isCount(t.count), "thread.count");
  }
  checkMode(raw.mode);
  const c = raw.composer;
  need(isObject(c), "composer");
  need(typeof c.text === "string", "composer.text");
  need(isCount(c.cursor), "composer.cursor");
  checkMedia(raw.staged, "staged");
  need(Array.isArray(raw.pending), "pending");
  raw.pending.forEach((item, i) => checkItem(item, `pending[${i}]`));
  need(Array.isArray(raw.history) && raw.history.every((h) => typeof h === "string"), "history");
  const n = raw.counters;
  need(isObject(n), "counters");
  for (const key of ["nextLabel", "nextViewed", "nextLetter"]) need(isCount(n[key]), `counters.${key}`);
  return raw as unknown as ReplSessionFile;
}
