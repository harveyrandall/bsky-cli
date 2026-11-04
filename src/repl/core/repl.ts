import { graphemeLength } from "@/lib/split-thread";
import type { Draft } from "@/lib/types";
import type { LineStyle } from "./commands";
import { escapeMarkers, parseSubmit, type Markers, type SubmitPlan } from "./markers";
import { Pipeline, draftOf, type Countdown, type Failure, type Intent, type PipelineDeps, type QueueItem, type SendTarget, type Unsent } from "./pipeline";
import { Registry, looksLikeRef, resolveRef, type RefAgent, type RegistryEntry, type ResolvedRef } from "./refs";
import type { Cooldown, StrongRef, ThreadLetter } from "./types";

export const IDLE_HINT =
  "Plain text needs a thread: /thread to start one, /post for a single post, or -t to do this automatically.";
const WAIT = "Wait for pending posts, or Esc to cancel them";
const LABEL = "🧵";

export type ReplMode =
  | { kind: "idle" }
  | { kind: "thread" }
  | { kind: "reply-once"; target: ResolvedRef; label: string; returnTo: "idle" | "thread" }
  | { kind: "post-once"; returnTo: "idle" | "thread" };

export interface ReplSettings {
  autoThread: boolean;
  prefixThread: boolean;
  threadLabel: false | "append" | "prepend";
  /** Unset: asked before the first thread. */
  undo?: Cooldown;
  pace?: Cooldown;
  askToSave: boolean;
  verbose: boolean;
}

/** Questions the REPL asks the person at the keyboard. */
export interface ReplAsk {
  /** undefined when dismissed. */
  cooldown(kind: "undo" | "pace"): Promise<Cooldown | undefined>;
  saveOffer(values: { undo?: Cooldown; pace?: Cooldown }): Promise<"yes" | "no" | "never">;
  /** The split preview; defaults to No. */
  confirm(plan: SubmitPlan, labelled: boolean): Promise<boolean>;
}

export interface ReplAgent extends RefAgent {
  post(text: string, reply?: SendTarget): Promise<StrongRef>;
}

export interface ReplDeps {
  agent: ReplAgent;
  ask: ReplAsk;
  print(text: string, style?: LineStyle): void;
  onChange(): void;
  /** Put text back in the composer (after an asynchronous failure). */
  restore(text: string): void;
  saveDraft(d: Omit<Draft, "id" | "createdAt">): Promise<{ id: string }>;
  deleteDraft(id: string): Promise<void>;
  saveConfig(values: Record<string, string | number | boolean>): Promise<void>;
  timers?: Pick<PipelineDeps, "now" | "setTimer" | "clearTimer">;
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

type WriteKind = "thread" | "reply" | "standalone";

const stripLabel = (text: string) => text.replace(/\n🧵$|^🧵\n/, "");
const manualDraft = (item: Unsent) => draftOf("manual", item.posts.map(stripLabel), item.target);

/**
 * The session (spec §5): mode, active thread, settings, the post registry and
 * the send pipeline. UI-free: it talks to the network through `agent`, to the
 * person through `ask`, and reports through `print`.
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
  private readonly letters = new Map<number, ThreadLetter | undefined>();

  constructor(
    settings: ReplSettings,
    private readonly markers: Markers,
    private readonly deps: ReplDeps,
  ) {
    this.s = { ...settings };
    this.registry = new Registry(settings.prefixThread, deps.agent.selfDid);
    const timers = deps.timers ?? {
      now: () => Date.now(),
      setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimer: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    this.pipeline = new Pipeline({
      ...timers,
      send: (text, reply) => deps.agent.post(text, reply),
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

  /** What paused the queue, while it's paused. */
  pausedBy(): Failure | undefined {
    return this.pipeline.lastFailure();
  }

  sendNow(): void {
    this.pipeline.sendNow();
  }

  /** What's queued, as drafts that send it to the same places. */
  draftItems(): Omit<Draft, "id" | "createdAt">[] {
    return this.pipeline.pending().map(manualDraft);
  }

  prompt(): string {
    switch (this.current.kind) {
      case "idle":
        return "bsky ›";
      case "post-once":
        return "post ›";
      case "reply-once":
        return `reply→${this.current.label} ›`;
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

  private labelled(kind: WriteKind, root?: StrongRef): boolean {
    if (!this.s.threadLabel || kind === "standalone") return false;
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
      case "reply-once": {
        const out = await this.write({ kind: "reply", target: mode.target.ref, root: mode.target.root }, text);
        if (out !== "keep") this.current = { kind: mode.returnTo };
        return out;
      }
      case "post-once": {
        const out = await this.write({ kind: "standalone" }, text);
        if (out !== "keep") this.current = { kind: mode.returnTo };
        return out;
      }
    }
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

  /** Ask for unset undo/pace once per session, then offer to save the answers. */
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

  setAutoThread(on = !this.s.autoThread): void {
    this.s.autoThread = on;
    this.deps.print(`Auto-thread ${on ? "on" : "off"}`, "dim");
  }

  setCooldown(kind: "undo" | "pace", value: Cooldown): void {
    this.s[kind] = value;
    this.cooldownsSettled ||= this.s.undo !== undefined && this.s.pace !== undefined;
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
    if (this.current.kind === "reply-once" || this.current.kind === "post-once") {
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

  /** Ctrl+C below any overlay: like Esc, but it clears text first and hints when idle. */
  interrupt(composerText: string): "clear" | "handled" | "hint" | { restore: string } {
    const once = this.current.kind === "reply-once" || this.current.kind === "post-once";
    if (this.busy() || once) {
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
    return composerText.trim() !== "" || this.pipeline.pending().length > 0;
  }

  private cancelPending(composerText: string): EscapeResult {
    const draftId = this.pipeline.lastFailure()?.draftId;
    if (draftId) this.deps.print(`Left in draft ${draftId}`, "dim");
    const items = this.pipeline.cancelAll();
    if (items.length === 0) return "handled";
    if (composerText.trim() !== "") {
      void this.saveCancelled(items);
      return "handled";
    }
    return { restore: items.length === 1 ? this.asResend(items[0]) : this.join(items.flatMap((i) => i.posts)) };
  }

  private async saveCancelled(items: readonly Unsent[]): Promise<void> {
    for (const item of items) {
      try {
        const d = await this.deps.saveDraft(manualDraft(item));
        this.deps.print(`Saved as draft ${d.id}`, "dim");
      } catch (err) {
        // Never lose it: show the text so it can be copied.
        this.deps.print(`Couldn't save the cancelled posts as a draft (${err instanceof Error ? err.message : String(err)}):`, "error");
        this.deps.print(this.join(item.posts));
      }
    }
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
    if (plan.overLimit.length) {
      for (const i of plan.overLimit) {
        this.deps.print(`Post ${i + 1} is ${graphemeLength(plan.posts[i])}/${limit} — shorten it or split it`, "error");
      }
      return "keep";
    }
    const direct = plan.posts.length === 1 && !plan.markersUsed && !plan.autoSplit;
    if (!direct && !(await this.deps.ask.confirm(plan, labelled))) return "keep";

    const posts = labelled ? this.labelPosts(plan.posts) : plan.posts;
    // A question may have been answered after the REPL started closing.
    if (this.closed) return "keep";
    const item = this.pipeline.enqueue(intent, posts);
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

  private onSent(item: QueueItem, index: number, ref: StrongRef, target: SendTarget | undefined): void {
    const root = target?.root ?? ref;
    const entry = this.registry.addOwn(ref, {
      root,
      parent: target?.parent.uri,
      text: stripLabel(item.posts[index]),
      letter: this.letters.get(item.id),
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
      this.deps.restore(this.asResend({ ...f.item, posts: f.item.posts.slice(f.from), target: f.target }));
    }
    this.deps.onChange();
  }

  /** Posts coming back, as what Enter needs to send them to the same place. */
  private asResend(item: Unsent): string {
    const text = this.join(item.posts);
    const { kind } = item.intent;
    if (kind === "thread" && this.current.kind === "thread") return text;
    const parent = item.target && this.registry.byUri(item.target.parent.uri);
    if (parent) return `/reply ${parent.label} ${text}`;
    return `/${kind === "thread" ? "thread" : "post"} ${text}`;
  }
}
