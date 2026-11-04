import { basename } from "node:path";
import { formatLocalDateTime, parseDate, parseTime, resolveAmPm, toUtcIso } from "@/lib/date-prompt";
import { graphemeLength } from "@/lib/split-thread";
import type { Draft, ScheduledPost } from "@/lib/types";
import type { LineStyle } from "./commands";
import { escapeMarkers, parseSubmit, type Markers, type SubmitPlan } from "./markers";
import { canStage, chips, expandHome, inspectMedia, mediaOptions, nodeMediaFs, parseDroppedPaths, type MediaFs, type StagedMedia } from "./media";
import { Pipeline, draftOf, quoteOf, type Countdown, type Failure, type Intent, type PipelineDeps, type QueueItem, type SendTarget, type Unsent } from "./pipeline";
import { Registry, looksLikeRef, resolveRef, type RefAgent, type RegistryEntry, type ResolvedRef } from "./refs";
import type { Cooldown, StrongRef, ThreadLetter } from "./types";

export const IDLE_HINT =
  "Plain text needs a thread: /thread to start one, /post for a single post, or -t to do this automatically.";
const WAIT = "Wait for pending posts, or Esc to cancel them";
const LABEL = "🧵";
const ALT_INTRO = "Alt text tells people using screen readers what's in your image — without it, they're left out of the post.";

const NEW_ITEMS = ["Post", "Thread", "Image post", "Video post", "Quote post", "Scheduled post", "Draft"] as const;

type ReturnTo = "idle" | "thread";

export type ReplMode =
  | { kind: "idle" }
  | { kind: "thread" }
  | { kind: "reply-once" | "quote-once"; target: ResolvedRef; label: string; returnTo: ReturnTo }
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
  /** undefined when dismissed. */
  choose(label: string, options: readonly string[]): Promise<number | undefined>;
  /** A line of text; undefined when dismissed. */
  text(label: string): Promise<string | undefined>;
}

export interface ReplAgent extends RefAgent {
  post(text: string, reply?: SendTarget, media?: readonly StagedMedia[], quote?: StrongRef): Promise<StrongRef>;
}

export interface ReplDeps {
  agent: ReplAgent;
  ask: ReplAsk;
  print(text: string, style?: LineStyle): void;
  onChange(): void;
  /** Text coming back after an asynchronous failure. */
  restore(text: string): void;
  saveDraft(d: Omit<Draft, "id" | "createdAt">): Promise<{ id: string }>;
  deleteDraft(id: string): Promise<void>;
  saveConfig(values: Record<string, string | number | boolean>): Promise<void>;
  saveScheduled(p: Omit<ScheduledPost, "id" | "createdAt">): Promise<{ id: string }>;
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
 * The session: mode, active thread, settings, the post registry and the send
 * pipeline. UI-free: it talks to the network through `agent`, to the person
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

  /** The composer's text and whatever's staged, as a draft; undefined if there's neither. */
  composerDraft(text: string): Omit<Draft, "id" | "createdAt"> | undefined {
    if (text.trim() === "" && this.media.length === 0) return undefined;
    return draftOf("manual", [text], { media: this.media });
  }

  /** What paused the queue, while it's paused. */
  pausedBy(): Failure | undefined {
    return this.pipeline.lastFailure();
  }

  sendNow(): void {
    this.pipeline.sendNow();
  }

  /** Media waiting for the next post. */
  staged(): readonly StagedMedia[] {
    return this.media;
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
    if (out !== "keep") this.current = { kind: mode.returnTo };
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
      const path = expandHome(raw);
      const found = await inspectMedia(path, this.deps.fs ?? nodeMediaFs);
      if ("error" in found) {
        this.deps.print(found.error, "error");
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
        if (answer === null) continue;
        text = answer;
      }
      this.media.push({ path, kind: found.kind, ...(text !== undefined && { alt: text }) });
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

  /** `/detach [n|all]`: unstage one file (from 1) or all of them. */
  detach(which: number | "all" = "all"): void {
    if (which !== "all" && !this.media[which - 1]) {
      this.deps.print(`No attachment ${which}`, "error");
      return;
    }
    this.media = which === "all" ? [] : this.media.filter((_, i) => i !== which - 1);
    this.deps.onChange();
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

  /** `/new`: pick what to write next, which ends the thread. */
  async newMenu(): Promise<SubmitOutcome> {
    if (this.blockedByPending()) return "keep";
    const pick = await this.deps.ask.choose("New:", NEW_ITEMS);
    if (pick === undefined) return "keep";
    if (this.threadState) this.stopThread();
    this.current = { kind: "idle" };
    this.deps.onChange();
    switch (NEW_ITEMS[pick]) {
      case "Post":
        return this.post();
      case "Thread":
        return this.startThread();
      case "Image post":
      case "Video post": {
        const path = await this.deps.ask.text("Path to the file:");
        if (path === undefined) return "keep";
        await this.attach(parseDroppedPaths(path) ?? [path.trim()]);
        return this.media.length > 0 ? this.post() : "keep";
      }
      case "Quote post": {
        const ref = await this.deps.ask.text("Post to quote (number, link or at:// URI):");
        return ref === undefined ? "keep" : this.quote(ref);
      }
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

  private async schedule(text: string): Promise<SubmitOutcome> {
    const plan = parseSubmit(text, this.markers, 300);
    if (plan.posts.length !== 1) {
      this.deps.print("A scheduled post is a single post of up to 300 characters", "error");
      return "keep";
    }
    const scheduledAt = await this.askDateTime();
    if (scheduledAt === undefined) return "keep";
    const saved = await this.deps.saveScheduled({ scheduledAt, text: plan.posts[0], ...mediaOptions(this.media) });
    this.media = [];
    this.deps.print(`Scheduled for ${formatLocalDateTime(scheduledAt)} (${saved.id})`, "dim");
    return plan.keep ? { restore: plan.keep } : "done";
  }

  private async saveAsDraft(text: string): Promise<SubmitOutcome> {
    const plan = parseSubmit(text, this.markers, 300);
    if (plan.posts.length === 0) return "keep";
    const saved = await this.deps.saveDraft(draftOf("manual", plan.posts, { media: this.media }));
    this.media = [];
    this.deps.print(`Saved as draft ${saved.id}`, "dim");
    return plan.keep ? { restore: plan.keep } : "done";
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
    return composerText.trim() !== "" || this.media.length > 0 || this.pipeline.pending().length > 0;
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
    for (const item of items) this.restage(item.media);
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
      if (f.from === 0) this.restage(f.item.media);
      this.deps.restore(this.asResend({ ...f.item, posts: f.item.posts.slice(f.from), target: f.target }));
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
