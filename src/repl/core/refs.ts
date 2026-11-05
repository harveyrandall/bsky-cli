import { graphemeLength } from "@/lib/split-thread";
import {
  isAtUri,
  isDid,
  isHandle,
  isRkey,
  rkeyOf,
  type AtUri,
  type Cid,
  type Did,
  type Handle,
  type OwnLabel,
  type Rkey,
  type StrongRef,
  type ThreadLetter,
  type ViewedLabel,
} from "./types";

/** A post you made, or an external post you targeted, in this session. */
export interface RegistryEntry {
  label: OwnLabel;
  uri: AtUri;
  cid: Cid;
  rkey: Rkey;
  authorDid: Did;
  root: StrongRef;
  parent?: AtUri;
  excerpt: string;
  /** What went with it, as printed: `📷 2`, `🎞`, `❝ 3`. */
  notes?: string;
  /** Deleted since. It keeps its label: labels are never reused. */
  deleted?: boolean;
  /** The author's handle, for a post not made in this session: someone else's, or an older one of yours. */
  external?: Handle;
  letter?: ThreadLetter;
}

/** A post you read: printed with a `#n`, so that you can act on it. */
export interface ViewedEntry extends StrongRef {
  label: ViewedLabel;
}

/** What the REPL needs to know about a post fetched from the network. */
export interface PostLookup {
  uri: AtUri;
  cid: Cid;
  authorDid: Did;
  authorHandle: Handle;
  text: string;
  root?: StrongRef;
  parent?: StrongRef;
}

export interface RefAgent {
  selfDid: Did;
  resolveHandle(handle: string): Promise<Did>;
  getPosts(uris: AtUri[]): Promise<PostLookup[]>;
}

export interface ResolvedRef {
  ref: StrongRef;
  root: StrongRef;
  entry?: RegistryEntry;
  post?: PostLookup;
}

const segmenter = new Intl.Segmenter();

function excerptOf(text: string): string {
  const firstLine = text.split("\n")[0];
  if (graphemeLength(firstLine) <= 40) return firstLine;
  return [...segmenter.segment(firstLine)].slice(0, 40).map((g) => g.segment).join("") + "…";
}

/** 0 → A, 25 → Z, 26 → AA. */
function letterOf(n: number): ThreadLetter {
  let letters = "";
  for (let i = n + 1; i > 0; i = Math.floor((i - 1) / 26)) letters = String.fromCharCode(65 + ((i - 1) % 26)) + letters;
  return letters as ThreadLetter;
}

/**
 * Labels are never reused. Session-wide mode numbers everything 1, 2, 3…;
 * prefixed mode gives each thread and standalone post a letter and numbers
 * posts within it.
 */
export class Registry {
  private readonly list: RegistryEntry[] = [];
  private readonly seen: ViewedEntry[] = [];
  private nextViewed = 1;
  private count = 0;
  private letters = 0;
  private readonly perLetter = new Map<ThreadLetter, number>();
  private lastLetter?: ThreadLetter;

  constructor(
    readonly prefixed: boolean,
    private self?: Did,
  ) {}

  /** Who's writing, after a `/switch`. */
  setSelf(did: Did): void {
    this.self = did;
  }

  markDeleted(uri: string): void {
    const entry = this.byUri(uri);
    if (entry) entry.deleted = true;
  }

  newLetter(): ThreadLetter {
    this.lastLetter = letterOf(this.letters++);
    return this.lastLetter;
  }

  /** The letter a bare number refers to when no thread is active. */
  currentLetter(): ThreadLetter | undefined {
    return this.lastLetter;
  }

  private nextLabel(letter?: ThreadLetter): OwnLabel {
    if (!this.prefixed) return `${++this.count}` as OwnLabel;
    const l = letter ?? this.newLetter();
    const n = (this.perLetter.get(l) ?? 0) + 1;
    this.perLetter.set(l, n);
    this.lastLetter = l;
    return `${l}${n}` as OwnLabel;
  }

  private add(entry: RegistryEntry): RegistryEntry {
    this.list.push(entry);
    return entry;
  }

  addOwn(ref: StrongRef, o: { root: StrongRef; parent?: AtUri; text: string; letter?: ThreadLetter; notes?: string }): RegistryEntry {
    return this.add({
      label: this.nextLabel(o.letter),
      ...ref,
      rkey: rkeyOf(ref.uri),
      authorDid: didOf(ref.uri),
      root: o.root,
      parent: o.parent,
      excerpt: excerptOf(o.text),
      notes: o.notes,
      letter: this.prefixed ? this.lastLetter : undefined,
    });
  }

  addExternal(post: PostLookup, o: { letter?: ThreadLetter; startsThread?: boolean }): RegistryEntry {
    const label =
      this.prefixed && o.startsThread && o.letter ? (`${o.letter}0` as OwnLabel) : this.nextLabel(o.letter);
    return this.add({
      label,
      uri: post.uri,
      cid: post.cid,
      rkey: rkeyOf(post.uri),
      authorDid: post.authorDid,
      root: post.root ?? { uri: post.uri, cid: post.cid },
      parent: post.parent?.uri,
      excerpt: excerptOf(post.text),
      external: post.authorHandle,
      letter: this.prefixed ? (o.letter ?? this.lastLetter) : undefined,
    });
  }

  /** The post's `#n`, a new one if it hasn't had one. */
  addViewed(ref: StrongRef): ViewedEntry {
    const known = this.seen.find((v) => v.uri === ref.uri);
    if (known) return known;
    const entry: ViewedEntry = { label: `#${this.nextViewed++}`, ...ref };
    this.seen.push(entry);
    return entry;
  }

  viewed(label: string): ViewedEntry | undefined {
    return this.seen.find((v) => v.label === label);
  }

  snapshot(): { posts: RegistryEntry[]; viewed: ViewedEntry[]; nextLabel: number; nextViewed: number; nextLetter: number } {
    return { posts: [...this.list], viewed: [...this.seen], nextLabel: this.count + 1, nextViewed: this.nextViewed, nextLetter: this.letters };
  }

  /** Picks up where a saved session stopped; labels are never reused. */
  restore(posts: readonly RegistryEntry[], counters: { nextLabel: number; nextViewed: number; nextLetter: number }, viewed: readonly ViewedEntry[] = []): void {
    this.list.push(...posts);
    this.seen.push(...viewed);
    this.count = counters.nextLabel - 1;
    this.nextViewed = counters.nextViewed;
    this.letters = counters.nextLetter;
    for (const e of posts) {
      if (!e.letter) continue;
      this.lastLetter = e.letter;
      const n = Number(e.label.slice(e.letter.length));
      this.perLetter.set(e.letter, Math.max(n, this.perLetter.get(e.letter) ?? 0));
    }
  }

  byLabel(label: string): RegistryEntry | undefined {
    return this.list.find((e) => e.label === label);
  }

  byUri(uri: string): RegistryEntry | undefined {
    return this.list.find((e) => e.uri === uri);
  }

  entries(): readonly RegistryEntry[] {
    return this.list;
  }

  /** For Tab: your posts, then what you've read, newest first. */
  recentLabels(): string[] {
    const own = this.list.filter((e) => !e.deleted).map((e) => e.label);
    return [...own.reverse(), ...this.snapshot().viewed.map((e) => e.label).reverse()];
  }

  /** `(4) 3lbx7kt5def2v`, then ` (at://…)` when verbose, ` ↳ 2` when its parent isn't the entry before it, ` ext @handle` for someone else's post, and what went with it. */
  format(e: RegistryEntry, verbose: boolean): string {
    const previous = this.list[this.list.indexOf(e) - 1];
    const branch = e.parent && e.parent !== previous?.uri ? ` ↳ ${this.byUri(e.parent)?.label ?? "?"}` : "";
    const uri = verbose ? ` (${e.uri})` : "";
    const ext = e.external && e.authorDid !== this.self ? ` ext @${e.external}` : "";
    return `(${e.label}) ${e.rkey}${uri}${branch}${ext}${e.notes ? ` ${e.notes}` : ""}`;
  }
}

// A record key must have a digit, so a 13-letter word is text.
const REF_SHAPE = /^(\d+|[A-Za-z]{1,3}\d+|#\d+|at:\/\/\S+|https:\/\/bsky\.app\/profile\/\S+|(?=[a-z]*[2-7])[2-7a-z]{13})$/;

/** Text that /thread reads as a ref rather than a first post. */
export const looksLikeRef = (text: string) => REF_SHAPE.test(text.trim());

export const postUrl = (uri: AtUri) => `https://bsky.app/profile/${didOf(uri)}/post/${rkeyOf(uri)}`;

export const didOf = (uri: AtUri): Did => uri.slice("at://".length, uri.indexOf("/", "at://".length)) as Did;

const cantResolve = (input: string) =>
  new Error(`Can't resolve "${input}": use a number, #n, rkey, at:// URI or bsky.app link`);

/** A failed network call, saying which ref it was for. */
async function lookingUp<T>(input: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw new Error(`Couldn't look up "${input}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function authorityToDid(authority: string, agent: RefAgent): Promise<Did | undefined> {
  if (isDid(authority)) return authority;
  return isHandle(authority) ? agent.resolveHandle(authority) : undefined;
}

/** The post a ref names (spec §5 order), with its thread root. */
export async function resolveRef(
  input: string,
  r: { registry: Registry; agent: RefAgent; letter?: ThreadLetter },
): Promise<ResolvedRef> {
  const s = input.trim();
  const fromEntry = (e: RegistryEntry): ResolvedRef => {
    if (e.deleted) throw new Error(`(${e.label}) is already deleted`);
    return { ref: { uri: e.uri, cid: e.cid }, root: e.root, entry: e };
  };

  if (/^\d+$/.test(s)) {
    const label = r.registry.prefixed ? `${r.letter ?? r.registry.currentLetter() ?? ""}${s}` : s;
    const entry = r.registry.byLabel(label);
    if (!entry) throw new Error(`No post (${label}) in this session`);
    return fromEntry(entry);
  }
  if (/^[A-Za-z]{1,3}\d+$/.test(s)) {
    if (!r.registry.prefixed) throw new Error(`"${s}" is a prefixed label; start the REPL with -l to use them`);
    const entry = r.registry.byLabel(s.toUpperCase());
    if (!entry) throw new Error(`No post (${s.toUpperCase()}) in this session`);
    return fromEntry(entry);
  }
  let uri: string | undefined;
  if (/^#\d+$/.test(s)) {
    uri = r.registry.viewed(s)?.uri;
    if (!uri) throw new Error(`No post ${s} in this session`);
  }
  const atUri = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/?#]+)$/.exec(s);
  const link = /^https:\/\/bsky\.app\/profile\/([^/]+)\/post\/([^/?#]+)\/?$/.exec(s);
  if (uri) {
    // A viewed post: found above.
  } else if (atUri || link) {
    const [, authority, rkey] = (atUri ?? link)!;
    const did = await lookingUp(input, () => authorityToDid(authority, r.agent));
    if (did) uri = `at://${did}/app.bsky.feed.post/${rkey}`;
  } else if (isRkey(s)) {
    uri = `at://${r.agent.selfDid}/app.bsky.feed.post/${s}`;
  }
  if (!isAtUri(uri)) throw cantResolve(input);

  const known = r.registry.byUri(uri);
  if (known) return fromEntry(known);
  const [post] = await lookingUp(input, () => r.agent.getPosts([uri]));
  if (!post) throw new Error(`Post not found: ${uri}`);
  return { ref: { uri: post.uri, cid: post.cid }, root: post.root ?? { uri: post.uri, cid: post.cid }, post };
}
