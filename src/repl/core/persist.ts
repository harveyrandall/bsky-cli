import { randomBytes } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { canStage, type StagedMedia } from "./media";
import { brokenRule, type Markers } from "./markers";
import type { Unsent } from "./pipeline";
import type { RegistryEntry, ViewedEntry } from "./refs";
import type { ReplSettings, ReturnTo, ThreadState } from "./repl";
import {
  isAtUri,
  isCid,
  isCooldown,
  isDid,
  isHandle,
  isIsoUtc,
  isOwnLabel,
  isRkey,
  isSessionId,
  isThreadLetter,
  isViewedLabel,
  type Did,
  type Handle,
  type IsoUtc,
  type OwnLabel,
  type SessionId,
  type ThreadLetter,
} from "./types";

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
  viewed: ViewedEntry[];
  thread?: ThreadState;
  /** What a bare number means once the thread has stopped. */
  lastThreadLetter?: ThreadLetter;
  mode: SavedMode;
  composer: { text: string; cursor: number };
  staged: StagedMedia[];
  pending: Unsent[];
  history: string[];
  counters: { nextLabel: number; nextViewed: number; nextLetter: number };
}

type Fields = Record<string, unknown>;

const isObject = (v: unknown): v is Fields => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const isRef = (v: unknown) => isObject(v) && isAtUri(v.uri) && isCid(v.cid);
const isTarget = (v: unknown) => isObject(v) && isRef(v.parent) && isRef(v.root);
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
  const seen: string[] = [];
  for (const key of ["split", "send", "cut"]) {
    need(brokenRule(s.markers[key], seen) === undefined, `settings.markers.${key}`);
    seen.push(s.markers[key] as string);
  }
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
  need(optional(e.letter, isThreadLetter), `${at}.letter`);
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
  need(optional(item.draftId, (v) => typeof v === "string"), `${at}.draftId`);
  if (item.media !== undefined) checkMedia(item.media, `${at}.media`);
  const intent = item.intent as Fields;
  if (intent.kind === "quote") need(item.posts.length === 1 && item.media === undefined && item.target === undefined, at);
  if (intent.kind === "reply" && item.target) {
    need(((item.target as Fields).root as Fields).uri === (intent.root as Fields).uri, `${at}.target`);
  }
}

/**
 * Fields that are each fine alone but would misdirect a post, or poison the next
 * save. Only what does harm: a session refused here is a session lost, so a
 * mismatch that's only shown, like `rkey`, is left alone.
 */
function checkTogether(f: ReplSessionFile): void {
  const labels = new Set<string>();
  const entries = new Map<string, RegistryEntry>();
  f.posts.forEach((e, i) => {
    const [, letter, n] = /^([A-Z]*)(\d+)$/.exec(e.label)!;
    need(f.settings.prefixThread === (e.letter !== undefined), `posts[${i}].letter`);
    need(!labels.has(e.label) && letter === (e.letter ?? "") && Number.isSafeInteger(Number(n)), `posts[${i}].label`);
    need(!entries.has(e.uri), `posts[${i}].uri`);
    if (!f.settings.prefixThread) need(Number(n) < f.counters.nextLabel, "counters.nextLabel");
    labels.add(e.label);
    entries.set(e.uri, e);
  });
  need(f.counters.nextLabel > 0, "counters.nextLabel");
  const viewed = new Set<string>();
  f.viewed.forEach((v, i) => {
    need(!viewed.has(v.label), `viewed[${i}].label`);
    need(Number(v.label.slice(1)) < f.counters.nextViewed, "counters.nextViewed");
    viewed.add(v.label);
  });
  const cursor = f.thread && entries.get(f.thread.cursor.uri);
  if (cursor) need(cursor.cid === f.thread!.cursor.cid && cursor.root.uri === f.thread!.root.uri, "thread.cursor");
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
  raw.viewed.forEach((v: unknown, i) => {
    need(isObject(v), `viewed[${i}]`);
    need(isViewedLabel(v.label), `viewed[${i}].label`);
    need(isAtUri(v.uri), `viewed[${i}].uri`);
    need(isCid(v.cid), `viewed[${i}].cid`);
  });
  if (raw.thread !== undefined) {
    const t = raw.thread;
    need(isObject(t), "thread");
    need(isRef(t.root), "thread.root");
    need(isRef(t.cursor), "thread.cursor");
    need(optional(t.letter, isThreadLetter), "thread.letter");
    need(isCount(t.count), "thread.count");
  }
  need(optional(raw.lastThreadLetter, isThreadLetter), "lastThreadLetter");
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
  const file = raw as unknown as ReplSessionFile;
  checkTogether(file);
  return file;
}

/** Nothing to come back to, so not worth keeping. */
export const isEmptySession = (f: ReplSessionFile) =>
  f.posts.length === 0 && f.composer.text.trim() === "" && f.staged.length === 0 && f.pending.length === 0;

export interface SessionListing {
  id: string;
  updatedAt?: string;
  summary: string;
  state: "ok" | "in use" | "unreadable";
  /** Posts still waiting to go. */
  unsent?: number;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export function newSessionId(): SessionId {
  return [...randomBytes(6)].map((b) => BASE32[b % 32]).join("") as SessionId;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function summaryOf(f: ReplSessionFile): string {
  const own = f.posts.filter((p) => !p.external);
  const threads = new Set(own.filter((p) => p.root.uri !== p.uri).map((p) => p.root.uri));
  const parts = [`@${f.handle}`, `${plural(threads.size, "thread")}, ${plural(own.length, "post")}`];
  return [...parts, ...(own[0] ? [`"${own[0].excerpt}"`] : [])].join(" · ");
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** How long a lock can stay empty before it's a crash, not a REPL about to write its PID. */
const LOCK_GRACE_MS = 5000;

const missing = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";

/** Session files: atomic writes, one REPL per session, oldest pruned first. */
export class SessionStore {
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {}

  private path(id: string, ext = "json"): string {
    return join(this.dir, `${id}.${ext}`);
  }

  /** One at a time, as the temp file is shared; a kill mid-write leaves the old file whole. */
  save(file: ReplSessionFile): Promise<void> {
    const write = async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const tmp = this.path(`${file.id}.${process.pid}`, "tmp");
      try {
        const json = JSON.stringify(file);
        parseSessionFile(JSON.parse(json)); // never replace a good file with one load() would refuse
        await writeFile(tmp, json, { mode: 0o600 });
        await rename(tmp, this.path(file.id));
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
    };
    this.saving = this.saving.then(write, write);
    return this.saving;
  }

  async load(id: SessionId): Promise<ReplSessionFile> {
    const file = parseSessionFile(JSON.parse(await readFile(this.path(id), "utf-8")));
    need(file.id === id, "id"); // a copy would otherwise lock and save the original
    return file;
  }

  /** Newest first; a file that won't parse sorts last, listed so it can be deleted. */
  async list(): Promise<SessionListing[]> {
    const names = await this.files();
    const ids = names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -".json".length));
    const unreadable = (id: string): SessionListing => ({ id, summary: "", state: "unreadable" });
    const listings = await Promise.all(ids.map((id) => (isSessionId(id) ? this.listing(id) : unreadable(id))));
    return listings.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  private async files(): Promise<string[]> {
    return readdir(this.dir).catch((err: unknown) => {
      if (missing(err)) return [];
      throw err;
    });
  }

  private async listing(id: string): Promise<SessionListing> {
    try {
      const file = await this.load(id as SessionId);
      const state = (await this.lockState(id)) === "held" ? "in use" : "ok";
      return { id, updatedAt: file.updatedAt, summary: summaryOf(file), state, unsent: file.pending.length };
    } catch {
      return { id, summary: "", state: "unreadable" };
    }
  }

  async delete(id: string): Promise<void> {
    await this.saving.catch(() => {}); // or a save still waiting would bring it back
    await rm(this.path(id), { force: true });
    await rm(this.path(id, "lock"), { force: true });
  }

  /** Read-only: looking at a lock must never take it from a REPL that's starting. */
  private async lockState(id: string): Promise<"free" | "stale" | "held"> {
    const path = this.path(id, "lock");
    let text: string;
    try {
      text = await readFile(path, "utf-8");
    } catch (err) {
      return missing(err) ? "free" : "held"; // can't tell, so it isn't ours
    }
    const pid = Number(text);
    if (text !== "") return pid > 0 && isRunning(pid) ? "held" : "stale";
    const { mtimeMs } = await stat(path);
    return Date.now() - mtimeMs < LOCK_GRACE_MS ? "held" : "stale";
  }

  lockPath(id: string): string {
    return this.path(id, "lock");
  }

  /** False if a REPL has it, this one included. */
  async lock(id: SessionId): Promise<boolean> {
    const state = await this.lockState(id);
    if (state === "held") return false;
    // ponytail: two REPLs clearing one stale lock at the same moment can both win; a PID check after writing would close that.
    if (state === "stale") await rm(this.lockPath(id), { force: true });
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    let file: FileHandle;
    try {
      file = await open(this.lockPath(id), "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
    try {
      await file.writeFile(String(process.pid));
      return true;
    } catch (err) {
      await rm(this.lockPath(id), { force: true });
      throw err;
    } finally {
      await file.close();
    }
  }

  async unlock(id: SessionId): Promise<void> {
    await rm(this.path(id, "lock"), { force: true });
  }

  /** Keeps the newest `keep`, anything in use and anything with unsent posts, and never touches a file it can't read. */
  async prune(keep: number): Promise<void> {
    const readable = (await this.list()).filter((l) => l.state !== "unreadable");
    const old = readable.slice(keep).filter((l) => l.state === "ok" && !l.unsent);
    await Promise.all(old.map((l) => this.delete(l.id)));
    await this.sweep();
  }

  /** What crashes leave behind: temp files, and locks with no session. */
  private async sweep(): Promise<void> {
    const names = await this.files();
    for (const name of names) {
      const tmp = /\.(\d+)\.tmp$/.exec(name);
      if (tmp && !isRunning(Number(tmp[1]))) await rm(join(this.dir, name), { force: true });
      const id = name.endsWith(".lock") ? name.slice(0, -".lock".length) : undefined;
      if (id && !names.includes(`${id}.json`) && (await this.lockState(id)) === "stale") await rm(this.lockPath(id), { force: true });
    }
  }
}

/** An id, a unique prefix of one, or `last`. */
export function resolveId(input: string, listings: readonly SessionListing[]): SessionId {
  if (input === "last") {
    const newest = listings.find((l) => l.state === "ok");
    if (!newest) throw new Error(listings.length > 0 ? "No saved session is free to resume" : "No saved sessions to resume");
    return newest.id as SessionId;
  }
  const matches = listings.filter((l) => l.id.startsWith(input));
  if (matches.length === 0) throw new Error(`No saved session "${input}"`);
  if (matches.length > 1) throw new Error(`"${input}" could be ${matches.map((l) => l.id).join(" or ")}`);
  return matches[0].id as SessionId;
}
