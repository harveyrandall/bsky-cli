import { basename, resolve } from "node:path";
import { formatLocalDateTime, parseDate, parseTime, resolveAmPm, toUtcIso } from "@/lib/date-prompt";
import { graphemeLength } from "@/lib/split-thread";
import type { Draft, ScheduledPost } from "@/lib/types";
import type { LineStyle } from "./commands";
import { escapeMarkers, parseSubmit, type Markers, type SubmitPlan } from "./markers";
import { canStage, chips, expandHome, inspectMedia, mediaOptions, nodeMediaFs, parseDroppedPaths, type MediaFs, type StagedMedia } from "./media";
import { Pipeline, draftOf, quoteOf, type Countdown, type Failure, type Intent, type PipelineDeps, type QueueItem, type SendTarget, type Unsent } from "./pipeline";
import type { ReplSessionFile, SavedMode } from "./persist";
import { Registry, looksLikeRef, resolveRef, type RefAgent, type RegistryEntry, type ResolvedRef } from "./refs";
import { isAtUri, isCid, type AtUri, type Cooldown, type IsoUtc, type OwnLabel, type StrongRef, type ThreadLetter } from "./types";

export const IDLE_HINT =
  "Plain text needs a thread: /thread to start one, /post for a single post, or -t to do this automatically.";
const WAIT = "Wait for pending posts, or Esc to cancel them";
const LABEL = "🧵";
const ALT_INTRO = "Alt text tells people using screen readers what's in your image — without it, they're left out of the post.";

const NEW_ITEMS = ["Post", "Thread", "Image post", "Video post", "Quote post", "Scheduled post", "Draft"] as const;
const NEW_QUESTIONS: Partial<Record<(typeof NEW_ITEMS)[number], string>> = {
  "Image post": "Path to the file:",
  "Video post": "Path to the file:",
  "Quote post": "Post to quote (number, link or at:// URI):",
};

export type ReturnTo = "idle" | "thread";

export type ReplMode =
  | { kind: "idle" }
  | { kind: "thread" }
  | { kind: "reply-once" | "quote-once"; target: ResolvedRef; label: OwnLabel; returnTo: ReturnTo }
  | { kind: "post-once" | "schedule-once" | "draft-once"; returnTo: ReturnTo };

export interface ReplSettings {
  autoThread: boolean;
  prefixThread: boolean;
  threadLabel: false | "append" | "prepend";
  /** Unset: asked before the first thread. */
  undo?: Cooldown;
  pace?: Cooldown;
  askToSave: boolean;
  verbose: boolean;
  /** Attaching needs alt text. */
  forceAlt: boolean;
}

/** Questions the REPL asks the person at the keyboard. */
export interface ReplAsk {
  /** undefined when dismissed. */
  cooldown(kind: "undo" | "pace"): Promise<Cooldown | undefined>;
  saveOffer(values: { undo?: Cooldown; pace?: Cooldown }): Promise<"yes" | "no" | "never">;
  /** The split preview; defaults to No. */
  confirm(plan: SubmitPlan, labelled: boolean, media: readonly StagedMedia[]): Promise<boolean>;
  /** Alt text for a file: undefined when skipped, null on Esc. */
  alt(file: string, required: boolean): Promise<string | undefined | null>;
  /** undefined when dismissed. `start` is the option selected to begin with. */
  choose(label: string, options: readonly string[], start?: number): Promise<number | undefined>;
  /** A line of text; undefined when dismissed. */
  text(label: string): Promise<string | undefined>;
}

export interface ReplAgent extends RefAgent {
  post(text: string, reply?: SendTarget, media?: readonly StagedMedia[], quote?: StrongRef): Promise<StrongRef>;
  like(post: StrongRef): Promise<void>;
  /** False if there was no like to remove. */
  unlike(post: StrongRef): Promise<boolean>;
  repost(post: StrongRef): Promise<void>;
  /** False if there was no repost to remove. */
  unrepost(post: StrongRef): Promise<boolean>;
}

export interface ReplDeps {
  agent: ReplAgent;
  ask: ReplAsk;
  print(text: string, style?: LineStyle): void;
  onChange(): void;
  /** Text coming back after an asynchronous failure, into an idle composer. */
  restore(text: string): void;
  /** Whether what's in the composer, or the editor, would be in the way of text coming back. */
  composerBusy(): boolean;
  saveDraft(d: Omit<Draft, "id" | "createdAt">): Promise<{ id: string }>;
  deleteDraft(id: string): Promise<void>;
  saveConfig(values: Record<string, string | number | boolean>): Promise<void>;
  saveScheduled(p: Omit<ScheduledPost, "id" | "createdAt">): Promise<{ id: string }>;
  schedulerRunning(): boolean;
  timers?: Pick<PipelineDeps, "now" | "setTimer" | "clearTimer">;
  fs?: MediaFs;
}

/** "done" clears the composer, "keep" leaves it, `restore` replaces it. */
export type SubmitOutcome = "done" | "keep" | { restore: string };
export type EscapeResult = "handled" | "unhandled" | { restore: string };

export interface ThreadState {
  root: StrongRef;
  cursor: StrongRef;
  letter?: ThreadLetter;
  /** Your posts in this run of the thread. */
  count: number;
}

type WriteKind = Intent["kind"];

const stripLabel = (text: string) => text.replace(/\n🧵$|^🧵\n/, "");
const manualDraft = (item: Unsent) =>
  draftOf("manual", item.posts.map(stripLabel), { target: item.target, media: item.media, quote: quoteOf(item.intent) });

/**
 * The session: mode, active thread, settings, staged media, the post registry
 * and the send pipeline. UI-free: it talks to the network through `agent`, to the person
 * through `ask`, and reports through `print`. "Spec §n" here and nearby means
 * docs/superpowers/specs/2026-10-31-bsky-repl-design.md; this is §5.
 */
export class Repl {
  readonly registry: Registry;
  private readonly pipeline: Pipeline;
  private current: ReplMode = { kind: "idle" };
  private threadState?: ThreadState;
  private threadLetter?: ThreadLetter;
  /** What a bare number means once the thread has stopped. */
  private lastThreadLetter?: ThreadLetter;
  private readonly s: ReplSettings;
  private cooldownsSettled = false;
  private closed = false;
  private readonly failed: Failure[] = [];
  private media: StagedMedia[] = [];
  /** Saved posts waiting for Send, Edit or Discard. */
  private unanswered: Unsent[] = [];
  /** A resumed thread's posts couldn't be found. */
  private threadLost = false;
  private readonly timers: Pick<PipelineDeps, "now" | "setTimer" | "clearTimer">;
  private readonly letters = new Map<number, ThreadLetter | undefined>();

  constructor(
    settings: ReplSettings,
    private readonly markers: Markers,
    private readonly deps: ReplDeps,
  ) {
    this.s = { ...settings };
    this.registry = new Registry(settings.prefixThread, deps.agent.selfDid);
    this.timers = deps.timers ?? {
      now: () => Date.now(),
      setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimer: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    this.pipeline = new Pipeline({
      ...this.timers,
      send: (text, reply, media, quote) => deps.agent.post(text, reply, media, quote),
      threadTarget: () => this.threadState && { parent: this.threadState.cursor, root: this.threadState.root },
      saveDraft: deps.saveDraft,
      deleteDraft: deps.deleteDraft,
      settings: () => ({ undo: this.s.undo ?? 0, pace: this.s.pace ?? 0 }),
      onSent: (item, index, ref, target) => this.onSent(item, index, ref, target),
      onChange: deps.onChange,
      onFailed: (f) => this.onFailed(f),
      onWarning: (message) => deps.print(message, "error"),
    });
  }

  mode(): ReplMode {
    return this.current;
  }

  settings(): ReplSettings {
    return { ...this.s };
  }

  thread(): ThreadState | undefined {
    return this.threadState;
  }

  failures(): readonly Failure[] {
    return this.failed;
  }

  pendingCount(): number {
    return this.pipeline.pending().length;
  }

  countdown(): Countdown | undefined {
    return this.pipeline.countdown();
  }

  /** The post waiting out its undo window. */
  waiting(): string | undefined {
    const c = this.pipeline.countdown();
    return c?.phase === "counting" ? this.join(c.item.posts) : undefined;
  }

  /** The composer's text and whatever's staged, as drafts that send them where Enter would. */
  composerDrafts(text: string): Omit<Draft, "id" | "createdAt">[] {
    const media = this.media;
    if (text.trim() === "") return media.length > 0 ? [draftOf("manual", [""], { media })] : [];
    const { words, target, quote } = this.destination(text);
    if (quote) {
      // A quote can't carry media, or be a thread.
      return [draftOf("manual", [words], { quote }), ...(media.length > 0 ? [draftOf("manual", [""], { media })] : [])];
    }
    const plan = parseSubmit(words, this.markers, 300);
    const posts = [...plan.posts, ...(plan.keep ? [plan.keep] : [])];
    return [draftOf("manual", posts.length > 0 ? posts : [words], { target, media })];
  }

  /** Where composer text would go: a command that came back says, or else the mode does. */
  private destination(text: string): { words: string; target?: SendTarget; quote?: StrongRef } {
    const command = /^\/(post|thread|reply|quote)\s+([\s\S]*)$/.exec(text.trim());
    if (command?.[1] === "post" || command?.[1] === "thread") return { words: command[2] };
    if (command) {
      const [, label = "", words = ""] = /^(\S+)\s*([\s\S]*)$/.exec(command[2]) ?? [];
      const entry = this.registry.byLabel(label);
      if (entry) {
        const ref = { uri: entry.uri, cid: entry.cid };
        return command[1] === "quote" ? { words, quote: ref } : { words, target: { parent: ref, root: entry.root } };
      }
    }
    const m = this.current;
    if (m.kind === "reply-once") return { words: text, target: { parent: m.target.ref, root: m.target.root } };
    if (m.kind === "quote-once") return { words: text, quote: m.target.ref };
    const t = this.threadState;
    return { words: text, ...(m.kind === "thread" && t && { target: { parent: t.cursor, root: t.root } }) };
  }

  /** What paused the queue, while it's paused. */
  pausedBy(): Failure | undefined {
    return this.pipeline.lastFailure();
  }

  sendNow(): void {
    this.pipeline.sendNow();
  }

  /** Picks a saved session back up. Nothing is sent without being asked: a kill leaves no telling what went. */
  async resume(file: ReplSessionFile): Promise<void> {
    // All of it first, so a save at any moment from here has the whole session.
    this.registry.restore(file.posts, file.counters, file.viewed);
    this.threadState = file.thread;
    this.lastThreadLetter = file.lastThreadLetter;
    this.media = [...file.staged];
    this.unanswered = [...file.pending];
    this.current = this.resumeMode(file.mode);
    this.deps.print(`── resumed ${file.id} ──`, "dim");
    for (const entry of this.registry.entries()) this.deps.print(this.registry.format(entry, this.s.verbose), "dim");
    this.deps.onChange();
    await this.checkStaged();
    if (file.thread) await this.checkThread(file.thread);
    this.deps.onChange();
    for (const item of file.pending) await this.resumeItem(item);
  }

  private async checkStaged(): Promise<void> {
    for (const m of [...this.media]) {
      const found = await inspectMedia(m.path, this.deps.fs ?? nodeMediaFs);
      if (found.kind !== undefined && found.error === undefined) continue;
      this.media = this.media.filter((staged) => staged !== m);
      this.deps.print(`Dropped ${m.path}: ${found.error}`, "error");
    }
  }

  /** `work`, for as long as a person should be kept waiting. */
  private within<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: unknown;
    const timeout = new Promise<never>((_, reject) => {
      timer = this.timers.setTimer(() => reject(new Error("timed out")), ms);
    });
    return Promise.race([work, timeout]).finally(() => this.timers.clearTimer(timer));
  }

  /** When a post already going has landed, or five seconds, whichever's first. */
  settled(): Promise<void> {
    return this.within(this.pipeline.drained(), 5000).catch(() => {});
  }

  /** The cursor, or the nearest of its ancestors that's still there. */
  private async checkThread(saved: ThreadState): Promise<void> {
    const chain: string[] = [];
    // getPosts takes at most 25.
    for (let uri: string | undefined = saved.cursor.uri; uri && chain.length < 25; uri = this.registry.byUri(uri)?.parent) chain.push(uri);
    let found: Set<string>;
    try {
      found = new Set((await this.within(this.deps.agent.getPosts(chain as AtUri[]), 10_000)).map((p) => p.uri));
    } catch (err) {
      this.deps.print(`Couldn't check the thread (${err instanceof Error ? err.message : String(err)}); carrying on from where it was`, "error");
      return;
    }
    if (found.has(saved.cursor.uri)) return;
    const survivor = this.registry.byUri(chain.find((uri) => found.has(uri)) ?? "");
    if (!survivor) {
      this.deps.print("Couldn't find the thread's posts; thread stopped", "dim");
      this.threadState = undefined;
      this.threadLost = true;
      const m = this.current;
      if (m.kind === "thread") this.current = { kind: "idle" };
      else if (m.kind !== "idle") this.current = { ...m, returnTo: "idle" };
      return;
    }
    this.threadState = { ...saved, cursor: { uri: survivor.uri, cid: survivor.cid } };
    this.deps.print(`Couldn't find the post you were replying to; continuing from (${survivor.label})`, "dim");
  }

  private resumeMode(saved: SavedMode): ReplMode {
    if (!("target" in saved)) return saved;
    const entry = this.registry.byLabel(saved.target);
    if (!entry) return { kind: saved.returnTo };
    const target = { ref: { uri: entry.uri, cid: entry.cid }, root: entry.root, entry };
    return { kind: saved.kind, target, label: entry.label, returnTo: saved.returnTo };
  }

  private async resumeItem(saved: Unsent): Promise<void> {
    const threadPost = saved.intent.kind === "thread";
    const orphan = threadPost && this.threadLost;
    // A thread post goes after the cursor, whatever it was when saved.
    const item = threadPost ? { ...saved, target: undefined } : saved;
    const line = stripLabel(item.posts[0]).split("\n")[0];
    const note = orphan ? " (its thread couldn't be found, so Send starts a new one)" : "";
    // Edit first: a post in flight at a kill may already have gone.
    const answer = await this.deps.ask.choose(`Unsent from last time: "${line}"${note}`, ["Send", "Edit", "Discard"], 1);
    if (answer === 0) {
      const sent = this.pipeline.enqueue(item.intent, item.posts, item.media, item);
      this.letters.set(sent.id, this.letterFor(item.intent));
      if (threadPost && this.current.kind === "idle") this.current = { kind: "thread" };
    } else if (answer !== 2 && (this.deps.composerBusy() || !this.fits(item.media ?? []))) {
      await this.saveToDrafts([item], (id) => `Saved as draft ${id}`);
    } else if (answer !== 2) {
      this.restage(item.media);
      this.deps.restore(this.asResend(item));
    }
    // Sending deletes it on success; otherwise it's dealt with now, and sync mustn't send it too.
    if (answer !== 0 && item.draftId) {
      await this.deps.deleteDraft(item.draftId).catch((err: unknown) => {
        this.deps.print(`Couldn't delete draft ${item.draftId}, so it may send again on your next run: ${err instanceof Error ? err.message : String(err)}`, "error");
      });
    }
    // Only now: until it's somewhere else, a kill must leave it to ask about again.
    this.unanswered = this.unanswered.filter((i) => i !== saved);
    this.deps.onChange();
  }

  /** The session as a file. Tokens aren't part of it: the profile's own session file has those. */
  snapshot(
    meta: Pick<ReplSessionFile, "id" | "createdAt" | "handle" | "did" | "profile">,
    composer: ReplSessionFile["composer"],
    history: string[],
  ): ReplSessionFile {
    const { posts, viewed, nextLabel, nextViewed, nextLetter } = this.registry.snapshot();
    const m = this.current;
    const mode: SavedMode = "target" in m ? { kind: m.kind, target: m.label, returnTo: m.returnTo } : m;
    return {
      version: 1,
      ...meta,
      updatedAt: new Date().toISOString() as IsoUtc,
      settings: { ...this.s, markers: this.markers },
      posts,
      viewed,
      thread: this.threadState,
      lastThreadLetter: this.lastThreadLetter,
      mode,
      composer,
      staged: this.media,
      // Everything queued, a post in flight included: a kill leaves no telling if it went.
      pending: [...this.pipeline.pending(), ...this.unanswered],
      history,
      counters: { nextLabel, nextViewed, nextLetter },
    };
  }

  /** What to print before a post: `(n)` if it's in the session, or a `#n` to act on it by. */
  labelPost(post: { uri: string; cid: string }): string | undefined {
    if (!isAtUri(post.uri) || !isCid(post.cid)) return undefined;
    const own = this.registry.byUri(post.uri);
    if (own) return `(${own.label})`;
    const next = this.registry.snapshot().nextViewed;
    const { label } = this.registry.addViewed({ uri: post.uri, cid: post.cid });
    if (this.registry.snapshot().nextViewed !== next) this.deps.onChange();
    return label;
  }

  /** CLI arguments with each whole `#n` as its URI. A bare number is usually a count, so it's left alone. */
  expandLabels(argv: readonly string[]): string[] {
    return argv.map((arg) => this.registry.viewed(arg)?.uri ?? arg);
  }

  /** Media waiting for the next post. */
  staged(): readonly StagedMedia[] {
    return this.media;
  }

  /** What's queued, as drafts that send it to the same places. */
  draftItems(): Omit<Draft, "id" | "createdAt">[] {
    return this.pipeline.unsent().map(manualDraft);
  }

  prompt(): string {
    switch (this.current.kind) {
      case "idle":
        return "bsky ›";
      case "post-once":
        return "post ›";
      case "schedule-once":
        return "scheduled ›";
      case "draft-once":
        return "draft ›";
      case "reply-once":
        return `reply→${this.current.label} ›`;
      case "quote-once":
        return `quote→${this.current.label} ›`;
      case "thread": {
        const cursor = this.threadState && this.registry.byUri(this.threadState.cursor.uri);
        if (!cursor) return "thread ›";
        return this.registry.prefixed ? `thread ${cursor.letter} (${cursor.label}) ›` : `thread (${cursor.label}) ›`;
      }
    }
  }

  /** In a thread, or in a once mode on top of one. */
  private inThread(): boolean {
    const m = this.current;
    return m.kind === "thread" || (m.kind !== "idle" && m.returnTo === "thread");
  }

  /** Thread posts are labelled, and so are replies that stay in the active thread. */
  private labelled(kind: WriteKind, root?: StrongRef): boolean {
    if (!this.s.threadLabel || kind === "standalone" || kind === "quote") return false;
    return kind === "thread" || (this.inThread() && root?.uri === this.threadState?.root.uri);
  }

  /** The limit for plain text typed now. */
  composerLimit(): 298 | 300 {
    const m = this.current;
    const threads = m.kind === "thread" || (m.kind === "idle" && this.s.autoThread);
    const labelled = m.kind === "reply-once" ? this.labelled("reply", m.target.root) : this.labelled(threads ? "thread" : "standalone");
    return labelled ? 298 : 300;
  }

  /** Plain text typed in the current mode. */
  async submitText(text: string): Promise<SubmitOutcome> {
    const mode = this.current;
    switch (mode.kind) {
      case "idle":
        if (this.s.autoThread) return this.startThread(text, { asText: true });
        this.deps.print(IDLE_HINT, "dim");
        return "keep";
      case "thread":
        return this.write({ kind: "thread" }, text);
      case "reply-once":
        return this.once(mode, this.write({ kind: "reply", target: mode.target.ref, root: mode.target.root }, text));
      case "quote-once":
        return this.once(mode, this.write({ kind: "quote", target: mode.target.ref }, text));
      case "post-once":
        return this.once(mode, this.write({ kind: "standalone" }, text));
      case "schedule-once":
        return this.once(mode, this.schedule(text));
      case "draft-once":
        return this.once(mode, this.saveAsDraft(text));
    }
  }

  /** A once mode ends when what was typed has gone somewhere. */
  private async once(mode: { returnTo: ReturnTo }, submitted: Promise<SubmitOutcome>): Promise<SubmitOutcome> {
    const out = await submitted;
    if (out !== "keep") {
      this.current = { kind: mode.returnTo };
      this.deps.onChange();
    }
    return out;
  }

  private isOnce(): boolean {
    return this.current.kind !== "idle" && this.current.kind !== "thread";
  }

  /** Posts are queued, or paused after a failure. */
  private busy(): boolean {
    return this.pipeline.pending().length > 0 || this.pipeline.isPaused();
  }

  private blockedByPending(): boolean {
    if (!this.busy()) return false;
    this.deps.print(WAIT, "error");
    return true;
  }

  private async resolve(input: string): Promise<ResolvedRef | undefined> {
    try {
      return await resolveRef(input, {
        registry: this.registry,
        agent: this.deps.agent,
        letter: this.threadState?.letter ?? this.threadLetter ?? this.lastThreadLetter,
      });
    } catch (err) {
      this.deps.print(err instanceof Error ? err.message : String(err), "error");
      return undefined;
    }
  }

  /** The registry entry for a resolved ref, registering an external post the first time. */
  private entryFor(r: ResolvedRef, o: { letter?: ThreadLetter; startsThread?: boolean } = {}): RegistryEntry {
    return r.entry ?? this.registry.byUri(r.ref.uri) ?? this.registry.addExternal(r.post!, o);
  }

  /** Ask for unset undo/pace until answered, then offer to save the answers. False when dismissed. */
  private async settleCooldowns(): Promise<boolean> {
    if (this.cooldownsSettled) return true;
    const asked: { undo?: Cooldown; pace?: Cooldown } = {};
    for (const kind of ["undo", "pace"] as const) {
      if (this.s[kind] !== undefined) continue;
      const value = await this.deps.ask.cooldown(kind);
      if (value === undefined) return false;
      this.s[kind] = asked[kind] = value;
    }
    this.cooldownsSettled = true;
    if (Object.keys(asked).length === 0 || !this.s.askToSave) return true;
    const answer = await this.deps.ask.saveOffer(asked);
    try {
      if (answer === "yes") await this.deps.saveConfig(asked);
      if (answer === "never") {
        this.s.askToSave = false;
        await this.deps.saveConfig({ "ask-to-save": false });
      }
    } catch (err) {
      this.deps.print(`Couldn't save to config: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
    return true;
  }

  private stopThread(): void {
    const t = this.threadState;
    const root = t && this.registry.byUri(t.root.uri);
    this.deps.print(
      t && root ? `Thread stopped (${t.count} posts, root (${root.label}) ${root.rkey.slice(0, 4)}…)` : "Thread stopped",
      "dim",
    );
    this.lastThreadLetter = t?.letter ?? this.threadLetter;
    this.threadState = undefined;
    this.threadLetter = undefined;
    this.current = { kind: "idle" };
    this.deps.onChange();
  }

  /** `/thread [text|ref]`: enter thread mode, continue a thread, or start one with text. */
  async startThread(
    arg?: string,
    opts: { asText?: boolean; undo?: Cooldown; pace?: Cooldown } = {},
  ): Promise<SubmitOutcome> {
    if (this.blockedByPending()) return "keep";
    if (opts.undo !== undefined) this.s.undo = opts.undo;
    if (opts.pace !== undefined) this.s.pace = opts.pace;
    // The whole argument shaped like a ref continues that thread; anything else is the first post.
    const asRef = arg !== undefined && !opts.asText && looksLikeRef(arg);
    const resolved = asRef ? await this.resolve(arg) : undefined;
    if (asRef && !resolved) return "keep";
    const firstPost = asRef ? undefined : arg;
    if (!(await this.settleCooldowns())) return "keep";

    if (this.inThread() && this.threadState) this.stopThread();
    this.current = { kind: "thread" };
    this.threadState = undefined;
    this.threadLetter = this.registry.prefixed ? this.registry.newLetter() : undefined;
    if (resolved) {
      const entry = this.entryFor(resolved, { letter: this.threadLetter, startsThread: true });
      this.threadState = { root: resolved.root, cursor: resolved.ref, letter: entry.letter ?? this.threadLetter, count: 0 };
      this.deps.print(`Continuing the thread from (${entry.label})`, "dim");
    }
    this.deps.onChange();
    return firstPost !== undefined ? this.write({ kind: "thread" }, firstPost) : "done";
  }

  /** `/reply <ref> [text]`: reply once, now or in reply-once mode. */
  async reply(ref: string, text?: string): Promise<SubmitOutcome> {
    const resolved = await this.resolve(ref);
    if (!resolved) return "keep";
    const entry = this.entryFor(resolved, { letter: this.threadState?.letter });
    if (text !== undefined) return this.write({ kind: "reply", target: resolved.ref, root: resolved.root }, text);
    this.current = { kind: "reply-once", target: resolved, label: entry.label, returnTo: this.inThread() ? "thread" : "idle" };
    this.deps.onChange();
    return "done";
  }

  /** `/reply-from <ref>`: continue the thread from another post. */
  async replyFrom(ref: string): Promise<SubmitOutcome> {
    if (this.blockedByPending()) return "keep";
    const resolved = await this.resolve(ref);
    if (!resolved || !(await this.settleCooldowns())) return "keep";
    const entry = this.entryFor(resolved, { letter: this.threadState?.letter });
    const sameThread = this.threadState?.root.uri === resolved.root.uri;
    this.threadState = {
      root: resolved.root,
      cursor: resolved.ref,
      letter: entry.letter ?? this.threadState?.letter,
      count: sameThread ? this.threadState!.count : 0,
    };
    this.current = { kind: "thread" };
    this.deps.print(`Continuing from (${entry.label})`, "dim");
    this.deps.onChange();
    return "done";
  }

  /** `/post [text]`: a standalone post, now or in post-once mode. */
  async post(text?: string): Promise<SubmitOutcome> {
    if (text !== undefined) return this.write({ kind: "standalone" }, text);
    this.current = { kind: "post-once", returnTo: this.inThread() ? "thread" : "idle" };
    this.deps.onChange();
    return "done";
  }

  /** `/attach`: check each file, ask for its alt text and stage it for the next post. */
  async attach(paths: readonly string[], alt?: string): Promise<void> {
    let explained = false;
    for (const raw of paths) {
      // Absolute, because drafts and scheduled posts are sent from somewhere else.
      const path = resolve(expandHome(raw));
      const found = await inspectMedia(path, this.deps.fs ?? nodeMediaFs);
      if (found.error !== undefined || found.kind === undefined) {
        this.deps.print(found.error ?? `${basename(path)} can't be attached`, "error");
        continue;
      }
      const refused = canStage(this.media, found.kind);
      if (refused) {
        this.deps.print(refused, "error");
        continue;
      }
      let text = alt?.trim() || undefined;
      if (text === undefined) {
        if (!explained) this.deps.print(ALT_INTRO, "dim");
        explained = true;
        const answer = await this.askAlt(basename(path));
        if (answer === null) {
          this.deps.print(`Left out ${basename(path)}`, "dim");
          continue;
        }
        text = answer;
      }
      // Checked again: a post coming back during the prompt can stage media of its own.
      const late = canStage(this.media, found.kind);
      if (late) this.deps.print(late, "error");
      else this.media.push({ path, kind: found.kind, ...(text !== undefined && { alt: text }) });
      this.deps.onChange();
    }
  }

  // TODO(alt-text-ai): offer a description from a local model here.
  private async askAlt(file: string): Promise<string | undefined | null> {
    for (;;) {
      const answer = await this.deps.ask.alt(file, this.s.forceAlt);
      if (answer === null) return null;
      const text = answer?.trim();
      if (text) return text;
      if (!this.s.forceAlt) return undefined;
    }
  }

  /** Whether every path is media, even if too big, so that attaching it can say so. */
  async areMedia(paths: readonly string[]): Promise<boolean> {
    const found = await Promise.all(paths.map((p) => inspectMedia(resolve(expandHome(p)), this.deps.fs ?? nodeMediaFs)));
    return found.every((f) => f.kind !== undefined);
  }

  /** `/detach [n|all]`: unstage one file (from 1) or all of them. */
  detach(which: number | "all" = "all"): void {
    if (which !== "all" && !this.media[which - 1]) {
      this.deps.print(`No attachment ${which}`, "error");
      return;
    }
    this.media = which === "all" ? [] : this.media.filter((_, i) => i !== which - 1);
    this.deps.onChange();
  }

  /** Leaves anything staged since these were saved. */
  private unstage(saved: readonly StagedMedia[]): void {
    this.media = this.media.filter((m) => !saved.includes(m));
  }

  /** Whether media coming back can join what's been staged since. */
  private fits(media: readonly StagedMedia[]): boolean {
    return media.every((m, i) => !canStage([...this.media, ...media.slice(0, i)], m.kind));
  }

  /** Media coming back with its text; what's been staged since can get in the way. */
  private restage(media: readonly StagedMedia[] = []): void {
    for (const m of media) {
      const refused = canStage(this.media, m.kind);
      if (refused) this.deps.print(`Couldn't keep ${basename(m.path)}: ${refused}`, "error");
      else this.media.push(m);
    }
  }

  /** `/quote <ref> [text]`: quote once, now or in quote-once mode. */
  async quote(ref: string, text?: string): Promise<SubmitOutcome> {
    const resolved = await this.resolve(ref);
    if (!resolved) return "keep";
    const entry = this.entryFor(resolved, { letter: this.threadState?.letter });
    if (text !== undefined) return this.write({ kind: "quote", target: resolved.ref }, text);
    this.current = { kind: "quote-once", target: resolved, label: entry.label, returnTo: this.inThread() ? "thread" : "idle" };
    this.deps.onChange();
    return "done";
  }

  /** `/like`, `/unlike`, `/repost` and `/unrepost`. */
  async engage(action: "like" | "unlike" | "repost" | "unrepost", input: string): Promise<SubmitOutcome> {
    const resolved = await this.resolve(input);
    if (!resolved) return "keep";
    const name = resolved.entry ? `(${resolved.entry.label})` : input;
    const { agent } = this.deps;
    if (action === "like") {
      await agent.like(resolved.ref);
      this.deps.print(`Liked ${name}`, "dim");
    } else if (action === "repost") {
      await agent.repost(resolved.ref);
      this.deps.print(`Reposted ${name}`, "dim");
    } else if (action === "unlike") {
      this.deps.print((await agent.unlike(resolved.ref)) ? `Unliked ${name}` : `You hadn't liked ${name}`, "dim");
    } else {
      this.deps.print((await agent.unrepost(resolved.ref)) ? `Removed your repost of ${name}` : `You hadn't reposted ${name}`, "dim");
    }
    return "done";
  }

  /** `/new`: pick what to write next, which ends the thread. */
  async newMenu(): Promise<SubmitOutcome> {
    if (this.blockedByPending()) return "keep";
    const pick = await this.deps.ask.choose("New:", NEW_ITEMS);
    if (pick === undefined) return "done";
    const item = NEW_ITEMS[pick];
    // The thread stops only once there's something to do instead.
    const question = NEW_QUESTIONS[item];
    const answer = question ? (await this.deps.ask.text(question))?.trim() : undefined;
    if (question && !answer) return "done";
    if (this.threadState) this.stopThread();
    this.current = { kind: "idle" };
    this.deps.onChange();
    switch (item) {
      case "Post":
        return this.post();
      case "Thread":
        return this.startThread();
      case "Image post":
      case "Video post":
        await this.attach(parseDroppedPaths(answer!) ?? [answer!]);
        return this.media.length > 0 ? this.post() : "done";
      case "Quote post":
        return this.quote(answer!);
      case "Scheduled post":
        this.current = { kind: "schedule-once", returnTo: "idle" };
        break;
      case "Draft":
        this.current = { kind: "draft-once", returnTo: "idle" };
    }
    this.deps.onChange();
    return "done";
  }

  /** A future date and time from the person, as ISO UTC; undefined when dismissed. */
  private async askDateTime(): Promise<string | undefined> {
    for (;;) {
      const dateInput = await this.deps.ask.text("Date (DD-MM or DD-MM-YYYY):");
      if (dateInput === undefined) return undefined;
      const date = parseDate(dateInput);
      if (!date) {
        this.deps.print("Invalid date. Use DD-MM or DD-MM-YYYY format (e.g. 26-03 or 26-03-2026).", "error");
        continue;
      }
      const timeInput = await this.deps.ask.text("Time (HH:MM):");
      if (timeInput === undefined) return undefined;
      const time = parseTime(timeInput);
      if (!time) {
        this.deps.print("Invalid time. Use HH:MM format (e.g. 15:30 or 9:00).", "error");
        continue;
      }
      let { hours } = time;
      if (time.ambiguous) {
        const half = await this.deps.ask.choose("AM or PM?", ["AM", "PM"]);
        if (half === undefined) return undefined;
        hours = resolveAmPm(hours, half === 0 ? "am" : "pm");
      }
      const iso = toUtcIso(date.day, date.month, date.year, hours, time.minutes);
      if (new Date(iso) > new Date()) return iso;
      this.deps.print("Date must be in the future.", "error");
    }
  }

  /** Says which posts are over the limit, if any are. */
  private overLimit(plan: SubmitPlan, limit: number): boolean {
    for (const i of plan.overLimit) {
      this.deps.print(`Post ${i + 1} is ${graphemeLength(plan.posts[i])}/${limit} — shorten it or split it`, "error");
    }
    return plan.overLimit.length > 0;
  }

  private async schedule(text: string): Promise<SubmitOutcome> {
    const plan = parseSubmit(text, this.markers, 300);
    if (this.overLimit(plan, 300)) return "keep";
    if (plan.posts.length !== 1) {
      this.deps.print("A scheduled post is a single post of up to 300 characters", "error");
      return "keep";
    }
    const scheduledAt = await this.askDateTime();
    if (scheduledAt === undefined) return "keep";
    const media = [...this.media];
    const saved = await this.deps.saveScheduled({ scheduledAt, text: plan.posts[0], ...mediaOptions(media) });
    this.unstage(media);
    this.deps.print(`Scheduled for ${formatLocalDateTime(scheduledAt)} (${saved.id})`, "dim");
    if (!this.deps.schedulerRunning()) {
      this.deps.print("Nothing sends it until the scheduler runs: `bsky schedule enable`, or `bsky schedule watch` in another terminal", "dim");
    }
    if (plan.discard) this.deps.print(`Discarded: ${plan.discard}`, "dim");
    return plan.keep ? { restore: plan.keep } : "done";
  }

  private async saveAsDraft(text: string): Promise<SubmitOutcome> {
    const plan = parseSubmit(text, this.markers, 300);
    if (plan.posts.length === 0 || this.overLimit(plan, 300)) return "keep";
    const media = [...this.media];
    const saved = await this.deps.saveDraft(draftOf("manual", plan.posts, { media }));
    this.unstage(media);
    this.deps.print(`Saved as draft ${saved.id}`, "dim");
    if (plan.discard) this.deps.print(`Discarded: ${plan.discard}`, "dim");
    return plan.keep ? { restore: plan.keep } : "done";
  }

  setAutoThread(on = !this.s.autoThread): void {
    this.s.autoThread = on;
    this.deps.print(`Auto-thread ${on ? "on" : "off"}`, "dim");
    this.deps.onChange();
  }

  setCooldown(kind: "undo" | "pace", value: Cooldown): void {
    this.s[kind] = value;
    this.cooldownsSettled ||= this.s.undo !== undefined && this.s.pace !== undefined;
    this.deps.onChange();
  }

  /** `/settings` with no arguments: ask for each; dismissing keeps the current value. */
  async askSettings(): Promise<void> {
    for (const kind of ["undo", "pace"] as const) {
      const value = await this.deps.ask.cooldown(kind);
      if (value !== undefined) this.setCooldown(kind, value);
    }
  }

  settingsLine(): string {
    const show = (v?: Cooldown) => (v === undefined ? "ask" : v === 0 ? "off" : `${v}s`);
    return `undo ${show(this.s.undo)} · pace ${show(this.s.pace)} · auto-thread ${this.s.autoThread ? "on" : "off"}`;
  }

  async retry(): Promise<void> {
    const failure = this.pipeline.lastFailure();
    if (!(await this.pipeline.retry())) {
      this.deps.print("Nothing to retry", "dim");
      return;
    }
    // It's being dealt with; failing again records it afresh.
    this.failed.splice(this.failed.indexOf(failure!), 1);
    this.deps.print("Retrying…", "dim");
  }

  /** Esc below any overlay (spec §10). */
  escape(composerText: string): EscapeResult {
    if (this.busy()) return this.cancelPending(composerText);
    if (this.current.kind !== "idle" && this.current.kind !== "thread") {
      this.current = { kind: this.current.returnTo };
      this.deps.onChange();
      return "handled";
    }
    if (composerText.trim() !== "") return "unhandled";
    if (this.current.kind === "thread") {
      this.stopThread();
      return "handled";
    }
    return "unhandled";
  }

  /** Ctrl+C below any overlay: like Esc for pending posts and once modes; otherwise it clears text before stopping a thread, and hints when idle. */
  interrupt(composerText: string): "clear" | "handled" | "hint" | { restore: string } {
    if (this.busy() || this.isOnce()) {
      const r = this.escape(composerText);
      return r === "unhandled" ? "hint" : r;
    }
    if (composerText !== "") return "clear";
    if (this.current.kind === "thread") {
      this.stopThread();
      return "handled";
    }
    return "hint";
  }

  /** The REPL is going away: stop sending and refuse new posts. Returns what was still queued. */
  close(): QueueItem[] {
    this.closed = true;
    return this.pipeline.cancelAll({ keepDrafts: true });
  }

  wouldLose(composerText: string): boolean {
    return composerText.trim() !== "" || this.media.length > 0 || this.pipeline.pending().length > 0 || this.unanswered.length > 0;
  }

  private cancelPending(composerText: string): EscapeResult {
    const draftId = this.pipeline.lastFailure()?.draftId;
    if (draftId) this.deps.print(`Left in draft ${draftId}`, "dim");
    const items = this.pipeline.cancelAll();
    if (items.length === 0) return "handled";
    // One text can't hold items going to different places, or say which post has the media.
    const oneText = items.length === 1 || items.every((i) => i.intent.kind === "thread" && !i.media);
    const media = items.flatMap((i) => i.media ?? []);
    if (composerText.trim() !== "" || !oneText || !this.fits(media)) {
      void this.saveToDrafts(items, (id) => `Saved as draft ${id}`);
      return "handled";
    }
    this.restage(media);
    return { restore: items.length === 1 ? this.asResend(items[0]) : this.join(items.flatMap((i) => i.posts)) };
  }

  private async saveToDrafts(items: readonly Unsent[], saved: (id: string) => string): Promise<void> {
    for (const item of items) {
      try {
        const d = await this.deps.saveDraft(manualDraft(item));
        this.deps.print(saved(d.id), "dim");
      } catch (err) {
        // Never lose it: show the text so it can be copied.
        this.deps.print(`Couldn't save these posts as a draft (${err instanceof Error ? err.message : String(err)}):`, "error");
        this.deps.print(this.join(item.posts));
        this.restage(item.media);
      }
    }
    this.deps.onChange();
  }

  /** Posts as one text for the composer. */
  private join(posts: readonly string[]): string {
    return posts.map((p) => escapeMarkers(stripLabel(p), this.markers)).join(` ${this.markers.split} `);
  }

  private async write(intent: Intent, text: string): Promise<SubmitOutcome> {
    if (this.closed) return "keep";
    const kind: WriteKind = intent.kind;
    const root = intent.kind === "reply" ? intent.root : undefined;
    const labelled = this.labelled(kind, root);
    const limit = labelled ? 298 : 300;
    const plan = parseSubmit(text, this.markers, limit);
    if (plan.posts.length === 0) return "keep";
    if (this.overLimit(plan, limit)) return "keep";
    const quoting = intent.kind === "quote";
    if (quoting && plan.posts.length > 1) {
      this.deps.print("A quote is a single post: shorten it, or quote the first part and reply to it", "error");
      return "keep";
    }
    const direct = plan.posts.length === 1 && !plan.markersUsed && !plan.autoSplit;
    if (!direct && !(await this.deps.ask.confirm(plan, labelled, quoting ? [] : this.media))) return "keep";

    const posts = labelled ? this.labelPosts(plan.posts) : plan.posts;
    // A question may have been answered after the REPL started closing.
    if (this.closed) return "keep";
    const media = quoting ? [] : this.media;
    if (quoting && this.media.length > 0) this.deps.print(`Quote posts can't have media; ${chips(this.media)} stays for the next post`, "dim");
    if (!quoting) this.media = [];
    const item = this.pipeline.enqueue(intent, posts, media.length > 0 ? media : undefined);
    this.letters.set(item.id, this.letterFor(intent));
    if (plan.discard) this.deps.print(`Discarded: ${plan.discard}`, "dim");
    return plan.keep ? { restore: plan.keep } : "done";
  }

  /** Posts with the thread label added, as they will be sent. */
  labelPosts(posts: readonly string[]): string[] {
    return posts.map((p) => (this.s.threadLabel === "prepend" ? `${LABEL}\n${p}` : `${p}\n${LABEL}`));
  }

  private letterFor(intent: Intent): ThreadLetter | undefined {
    if (!this.registry.prefixed) return undefined;
    if (intent.kind === "thread") return this.threadState?.letter ?? this.threadLetter;
    if (intent.kind === "reply") return this.registry.byUri(intent.target.uri)?.letter ?? this.threadState?.letter;
    return this.registry.newLetter();
  }

  private notesFor(item: QueueItem, index: number): string | undefined {
    const quoted = quoteOf(item.intent);
    if (quoted) return `❝ ${this.registry.byUri(quoted.uri)?.label ?? "?"}`;
    const media = index === 0 ? item.media : undefined;
    if (!media?.length) return undefined;
    return media[0].kind === "video" ? "🎞" : `📷 ${media.length}`;
  }

  private onSent(item: QueueItem, index: number, ref: StrongRef, target: SendTarget | undefined): void {
    const root = target?.root ?? ref;
    const entry = this.registry.addOwn(ref, {
      root,
      parent: target?.parent.uri,
      text: stripLabel(item.posts[index]),
      letter: this.letters.get(item.id),
      notes: this.notesFor(item, index),
    });
    if (item.intent.kind === "thread") {
      this.threadState = {
        root,
        cursor: ref,
        letter: this.threadState?.letter ?? entry.letter,
        count: (this.threadState?.count ?? 0) + 1,
      };
    }
    this.deps.print(this.registry.format(entry, this.s.verbose));
    this.deps.onChange();
  }

  private onFailed(f: Failure): void {
    this.failed.push(f);
    const why = f.kind === "limited" ? "Rate limited" : "Couldn't reach Bluesky";
    if ((f.kind === "network" || f.kind === "limited") && f.draftId === undefined) {
      this.deps.print(`${why} (${f.message}). It's still queued: /retry to send it, Esc to cancel.`, "error");
    } else if (f.kind === "network" || f.kind === "limited") {
      this.deps.print(`${why}; saved as draft ${f.draftId}. /retry to send it ${f.kind === "limited" ? "later" : "now"}.`, "error");
    } else if (f.kind === "expired") {
      this.deps.print("Session expired — exit and run `bsky login`", "error");
      if (f.draftId) this.deps.print(`Unsent posts are saved as draft ${f.draftId}.`, "dim");
      else this.deps.print(f.message, "error");
    } else {
      const n = f.item.posts.length;
      this.deps.print(n > 1 ? `Post ${f.from + 1} of ${n} wasn't sent: ${f.message}` : f.message, "error");
      const back: Unsent = { ...f.item, posts: f.item.posts.slice(f.from), media: f.from === 0 ? f.item.media : undefined, target: f.target };
      if (this.deps.composerBusy() || !this.fits(back.media ?? [])) {
        // A draft keeps its text, media and destination together.
        void this.saveToDrafts([back], (id) => `A post came back while you were typing; saved it as draft ${id}`);
      } else {
        this.restage(back.media);
        this.deps.restore(this.asResend(back));
      }
    }
    this.deps.onChange();
  }

  /** Posts coming back, as what Enter needs to send them to the same place. */
  private asResend(item: Unsent): string {
    const text = this.join(item.posts);
    const { kind } = item.intent;
    if (kind === "thread" && this.current.kind === "thread") return text;
    if (kind === "quote") return `/quote ${this.registry.byUri(item.intent.target.uri)?.label ?? item.intent.target.uri} ${text}`;
    const parent = item.target && this.registry.byUri(item.target.parent.uri);
    if (parent) return `/reply ${parent.label} ${text}`;
    return `/${kind === "thread" ? "thread" : "post"} ${text}`;
  }
}
