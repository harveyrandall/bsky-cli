import { isNetworkError } from "@/lib/errors";
import type { Draft } from "@/lib/types";
import type { StrongRef } from "./types";

export type Intent = { kind: "thread" } | { kind: "reply"; target: StrongRef; root: StrongRef } | { kind: "standalone" };

export interface QueueItem {
  id: number;
  intent: Intent;
  posts: string[];
  createdAt: number;
}

/** counting = still inside the undo window; pacing = waiting on the pace only. */
export type Phase = "counting" | "pacing" | "sending";

export interface Countdown {
  item: QueueItem;
  phase: Phase;
  sendAt: number;
}

export interface SendTarget {
  parent: StrongRef;
  root: StrongRef;
}

export interface Failure {
  kind: "network" | "rejected" | "expired";
  item: QueueItem;
  /** Index of the post that failed; earlier posts were sent. */
  from: number;
  message: string;
  draftId?: string;
}

export interface PipelineDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  send(text: string, reply?: SendTarget): Promise<StrongRef>;
  /** Where the next thread post goes, read at send time. */
  threadTarget(): SendTarget | undefined;
  saveDraft(d: Omit<Draft, "id" | "createdAt">): Promise<{ id: string }>;
  deleteDraft(id: string): Promise<void>;
  settings(): { undo: number; pace: number };
  onSent(item: QueueItem, index: number, ref: StrongRef, target: SendTarget | undefined): void;
  onChange(): void;
  onFailed(f: Failure): void;
}

interface Active {
  item: QueueItem;
  /** Posts of `item` already sent. */
  index: number;
  /** The previous post sent in this item, and its thread root. */
  last?: SendTarget;
  /** Draft that a successful retry of this item replaces. */
  draftId?: string;
  /** Skip the undo window (a retry). */
  immediate?: boolean;
  rateLimited?: boolean;
}

type Classified = { kind: "network" | "rejected" | "expired" } | { kind: "wait"; ms: number };

/**
 * A FIFO of posts to send (spec §9). The first post of an item goes out at
 * max(enqueued + undo, last sent + pace), later ones at last sent + pace.
 * Parents are resolved at send time, so an item queued behind another replies
 * to it. A network failure saves the failed post and the rest of its item as
 * a draft and pauses the queue until retry() or cancelAll().
 */
export class Pipeline {
  private queue: Active[] = [];
  private nextId = 1;
  private lastSentAt = -Infinity;
  private timer: unknown;
  private sending = false;
  private paused = false;
  private failure?: Failure;
  /** The last post sent before the failure, so a retry chains from it. */
  private failedLast?: SendTarget;

  constructor(private readonly deps: PipelineDeps) {}

  enqueue(intent: Intent, posts: string[]): QueueItem {
    const item = { id: this.nextId++, intent, posts, createdAt: this.deps.now() };
    this.queue.push({ item, index: 0 });
    this.schedule();
    return item;
  }

  pending(): readonly QueueItem[] {
    return this.queue.map((a) => ({ ...a.item, posts: a.item.posts.slice(a.index) }));
  }

  /** Paused after a network failure, waiting for retry() or cancelAll(). */
  isPaused(): boolean {
    return this.paused;
  }

  countdown(): Countdown | undefined {
    const head = this.queue[0];
    if (!head || this.paused) return undefined;
    const sendAt = this.sendAt(head);
    const now = this.deps.now();
    const inUndo = head.index === 0 && !head.immediate && now < head.item.createdAt + this.deps.settings().undo * 1000;
    const phase: Phase = this.sending ? "sending" : inUndo ? "counting" : now < sendAt ? "pacing" : "sending";
    return { item: head.item, phase, sendAt };
  }

  lastFailure(): Failure | undefined {
    return this.failure;
  }

  sendNow(): void {
    const head = this.queue[0];
    if (!head || this.sending || this.paused) return;
    head.immediate = true;
    this.clear();
    void this.sendHead();
  }

  /** Cancel everything not yet sent; returns what was cancelled, oldest first. */
  cancelAll(): QueueItem[] {
    this.clear();
    // A post already being sent can't be stopped; it stays queued on its own.
    const inFlight = this.sending ? this.queue[0] : undefined;
    const cancelled = this.queue
      .map((a) => ({ ...a.item, posts: a.item.posts.slice(a === inFlight ? a.index + 1 : a.index) }))
      .filter((i) => i.posts.length > 0);
    // Truncate the in-flight item in place: sendHead still holds it and checks
    // its length when the send returns.
    if (inFlight) inFlight.item = { ...inFlight.item, posts: inFlight.item.posts.slice(0, inFlight.index + 1) };
    this.queue = inFlight ? [inFlight] : [];
    this.paused = false;
    this.deps.onChange();
    return cancelled;
  }

  /** Resend the last network failure; its draft is deleted once it all sends. */
  async retry(): Promise<boolean> {
    const f = this.failure;
    if (!f || f.kind === "rejected" || !this.paused) return false;
    if (f.draftId === undefined) {
      // The failed posts never left the queue (their draft couldn't be saved).
      this.failure = undefined;
      this.paused = false;
      this.schedule();
      return true;
    }
    const last = this.failedLast;
    const intent: Intent = last ? { kind: "reply", target: last.parent, root: last.root } : f.item.intent;
    const item = { ...f.item, intent, posts: f.item.posts.slice(f.from) };
    this.queue.unshift({ item, index: 0, draftId: f.draftId, immediate: true });
    this.failure = undefined;
    this.failedLast = undefined;
    this.paused = false;
    this.schedule();
    return true;
  }

  private clear(): void {
    if (this.timer !== undefined) this.deps.clearTimer(this.timer);
    this.timer = undefined;
  }

  private sendAt(a: Active): number {
    const { undo, pace } = this.deps.settings();
    const paced = this.lastSentAt + pace * 1000;
    // Only an item's first post waits out the undo window, and not on a retry.
    if (a.index > 0 || a.immediate) return paced;
    return Math.max(a.item.createdAt + undo * 1000, paced);
  }

  private schedule(): void {
    this.deps.onChange();
    const head = this.queue[0];
    if (!head || this.sending || this.paused || this.timer !== undefined) return;
    const wait = this.sendAt(head) - this.deps.now();
    if (wait <= 0) {
      void this.sendHead();
      return;
    }
    this.timer = this.deps.setTimer(() => {
      this.timer = undefined;
      void this.sendHead();
    }, wait);
  }

  private target(a: Active): SendTarget | undefined {
    if (a.last) return a.last;
    if (a.item.intent.kind === "reply") return { parent: a.item.intent.target, root: a.item.intent.root };
    if (a.item.intent.kind === "thread") return this.deps.threadTarget();
    return undefined;
  }

  private async sendHead(): Promise<void> {
    const a = this.queue[0];
    if (!a || this.sending) return;
    this.sending = true;
    this.deps.onChange();
    const target = this.target(a);
    try {
      const ref = await this.deps.send(a.item.posts[a.index], target);
      this.lastSentAt = this.deps.now();
      a.last = { parent: ref, root: target?.root ?? ref };
      this.deps.onSent(a.item, a.index, ref, target);
      a.index++;
      a.rateLimited = false;
      if (a.index >= a.item.posts.length) {
        if (this.queue[0] === a) this.queue.shift();
        if (a.draftId) await this.deps.deleteDraft(a.draftId);
      }
    } catch (err) {
      await this.fail(a, target, err);
    } finally {
      this.sending = false;
    }
    this.schedule();
  }

  private classify(err: unknown, a: Active): Classified {
    const e = err as { status?: number; error?: string; headers?: Record<string, string> };
    if (e.status === 429) {
      const ms = Number(e.headers?.["ratelimit-reset"]) * 1000 - this.deps.now();
      return !a.rateLimited && ms >= 0 && ms <= 60_000 ? { kind: "wait", ms } : { kind: "network" };
    }
    if (e.status === 401 || e.error === "ExpiredToken" || e.error === "InvalidToken") return { kind: "expired" };
    return isNetworkError(err) ? { kind: "network" } : { kind: "rejected" };
  }

  private async fail(a: Active, target: SendTarget | undefined, err: unknown): Promise<void> {
    const c = this.classify(err, a);
    if (c.kind === "wait") {
      a.rateLimited = true;
      this.timer = this.deps.setTimer(() => {
        this.timer = undefined;
        void this.sendHead();
      }, c.ms);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const failure: Failure = { kind: c.kind, item: a.item, from: a.index, message };
    if (c.kind === "rejected") {
      if (this.queue[0] === a) this.queue.shift();
      this.deps.onFailed(failure);
      return;
    }
    this.paused = true;
    this.failure = failure;
    const rest = a.item.posts.slice(a.index);
    try {
      const draft = await this.deps.saveDraft({
        reason: "network",
        type: rest.length > 1 ? "thread" : target ? "reply" : "post",
        text: rest[0],
        ...(target && { replyUri: target.parent.uri }),
        ...(rest.length > 1 && { posts: rest.map((text) => ({ text })) }),
      });
      failure.draftId = draft.id;
      if (this.queue[0] === a) this.queue.shift();
      this.failedLast = a.last;
    } catch (saveErr) {
      // No draft, so the posts stay queued (paused) for /retry or Esc.
      failure.message = `${message}; couldn't save a draft either: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`;
      a.immediate = true;
    }
    this.deps.onFailed(failure);
  }
}
