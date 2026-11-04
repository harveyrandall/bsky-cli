import { isNetworkError } from "@/lib/errors";
import type { Draft } from "@/lib/types";
import { mediaOptions, type StagedMedia } from "./media";
import type { StrongRef } from "./types";

export type Intent =
  | { kind: "thread" }
  | { kind: "reply"; target: StrongRef; root: StrongRef }
  | { kind: "standalone" }
  | { kind: "quote"; target: StrongRef };

export interface QueueItem {
  id: number;
  intent: Intent;
  posts: string[];
  /** Goes with the first post. */
  media?: readonly StagedMedia[];
  createdAt: number;
}

/** What's left of a queued item, and where its next post is going. */
export interface Unsent extends QueueItem {
  target?: SendTarget;
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
  kind: "network" | "limited" | "rejected" | "expired";
  item: QueueItem;
  /** Index of the post that failed; earlier posts were sent. */
  from: number;
  /** Where that post was going. */
  target?: SendTarget;
  message: string;
  draftId?: string;
}

export interface PipelineDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  send(text: string, reply?: SendTarget, media?: readonly StagedMedia[], quote?: StrongRef): Promise<StrongRef>;
  /** Where the next thread post goes, read at send time. */
  threadTarget(): SendTarget | undefined;
  saveDraft(d: Omit<Draft, "id" | "createdAt">): Promise<{ id: string }>;
  deleteDraft(id: string): Promise<void>;
  settings(): { undo: number; pace: number };
  onSent(item: QueueItem, index: number, ref: StrongRef, target: SendTarget | undefined): void;
  onChange(): void;
  onFailed(f: Failure): void;
  /** Something went wrong after a post was sent; the post itself is fine. */
  onWarning(message: string): void;
}

/** The draft that sends `posts`, with `media` on the first, to `target` or quoting `quote`. */
export function draftOf(
  reason: Draft["reason"],
  posts: readonly string[],
  { target, media, quote }: { target?: SendTarget; media?: readonly StagedMedia[]; quote?: StrongRef } = {},
): Omit<Draft, "id" | "createdAt"> {
  const thread = posts.length > 1;
  return {
    reason,
    type: thread ? "thread" : quote ? "quote" : target ? "reply" : "post",
    text: posts[0],
    ...(target && { replyUri: target.parent.uri }),
    ...(quote && { quoteUri: quote.uri }),
    ...(thread ? { posts: posts.map((text, i) => ({ text, ...(i === 0 && mediaOptions(media)) })) } : mediaOptions(media)),
  };
}

export const quoteOf = (intent: Intent) => (intent.kind === "quote" ? intent.target : undefined);

/** An item's media, if its first post is among those from `from`. */
const mediaFrom = (item: QueueItem, from: number) => (from === 0 ? item.media : undefined);

interface Active {
  item: QueueItem;
  /** Posts of `item` already sent. */
  index: number;
  /** The previous post sent in this item, and its thread root. */
  last?: SendTarget;
  /** Draft that a successful retry of this item replaces. */
  draftId?: string;
  /** Skip the undo window (send now, or a retry). */
  immediate?: boolean;
  /** When a rate limit being waited out ends; set once per post. */
  limitedUntil?: number;
}

type Classified = { kind: Failure["kind"] } | { kind: "wait"; ms: number };

/**
 * A FIFO of posts to send (spec §9). The first post of an item goes out at
 * max(enqueued + undo, last sent + pace), later ones at last sent + pace.
 * Parents are resolved at send time, so a thread item queued behind another
 * replies to its last post. A network error, an expired session or a rate limit
 * too long to wait out saves the failed post and the rest of its item as a
 * draft and pauses the queue until retry() or cancelAll().
 */
export class Pipeline {
  private queue: Active[] = [];
  private nextId = 1;
  private lastSentAt = -Infinity;
  private timer: unknown;
  private sending = false;
  /** Set while paused, waiting for retry() or cancelAll(). */
  private failure?: Failure;

  constructor(private readonly deps: PipelineDeps) {}

  enqueue(intent: Intent, posts: string[], media?: readonly StagedMedia[]): QueueItem {
    const item = { id: this.nextId++, intent, posts, media, createdAt: this.deps.now() };
    this.queue.push({ item, index: 0 });
    this.schedule();
    return item;
  }

  pending(): readonly Unsent[] {
    return this.queue.map((a) => this.remaining(a, a.index));
  }

  /** What can still be stopped: everything but a post already being sent. */
  unsent(): Unsent[] {
    const inFlight = this.sending ? this.queue[0] : undefined;
    return this.queue.map((a) => this.remaining(a, a === inFlight ? a.index + 1 : a.index)).filter((i) => i.posts.length > 0);
  }

  private remaining(a: Active, from: number): Unsent {
    return { ...a.item, posts: a.item.posts.slice(from), media: mediaFrom(a.item, from), target: this.target(a) };
  }

  isPaused(): boolean {
    return this.failure !== undefined;
  }

  countdown(): Countdown | undefined {
    const head = this.queue[0];
    if (!head || this.failure) return undefined;
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
    if (!head || this.sending || this.failure || (head.limitedUntil ?? 0) > this.deps.now()) return;
    head.immediate = true;
    this.clear();
    void this.sendHead();
  }

  /**
   * Cancel everything not yet sent; returns what was cancelled, oldest first.
   * A retry's old draft goes too, since it holds posts sent since, unless the
   * caller can't take the text on (`keepDrafts`).
   */
  cancelAll(o: { keepDrafts?: boolean } = {}): Unsent[] {
    this.clear();
    const cancelled = this.unsent();
    // A post already being sent can't be stopped; it stays queued on its own.
    const inFlight = this.sending ? this.queue[0] : undefined;
    if (!o.keepDrafts) for (const a of this.queue) if (a !== inFlight) void this.dropDraft(a);
    // Truncate the in-flight item in place: sendHead still holds it and checks
    // its length when the send returns.
    if (inFlight) inFlight.item = { ...inFlight.item, posts: inFlight.item.posts.slice(0, inFlight.index + 1) };
    this.queue = inFlight ? [inFlight] : [];
    this.failure = undefined;
    this.deps.onChange();
    return cancelled;
  }

  /** Resend what paused the queue; its draft is deleted once it all sends. */
  async retry(): Promise<boolean> {
    const f = this.failure;
    // Still sending: its draft is being saved, and retrying now would race that.
    if (!f || this.sending) return false;
    // Without a draft, the failed posts never left the queue.
    if (f.draftId !== undefined) {
      const item = { ...f.item, posts: f.item.posts.slice(f.from), media: mediaFrom(f.item, f.from) };
      this.queue.unshift({ item, index: 0, last: f.target, draftId: f.draftId, immediate: true });
    }
    this.failure = undefined;
    this.schedule();
    return true;
  }

  private clear(): void {
    if (this.timer !== undefined) this.deps.clearTimer(this.timer);
    this.timer = undefined;
  }

  private sendAt(a: Active): number {
    const { undo, pace } = this.deps.settings();
    const paced = Math.max(this.lastSentAt + pace * 1000, a.limitedUntil ?? -Infinity);
    // Only an item's first post waits out the undo window, and not once sent now or retried.
    if (a.index > 0 || a.immediate) return paced;
    return Math.max(a.item.createdAt + undo * 1000, paced);
  }

  private schedule(): void {
    this.deps.onChange();
    const head = this.queue[0];
    if (!head || this.sending || this.failure || this.timer !== undefined) return;
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
    let ref: StrongRef;
    // Only the send itself can fail a post; what happens after it is bookkeeping.
    try {
      ref = await this.deps.send(a.item.posts[a.index], target, mediaFrom(a.item, a.index), quoteOf(a.item.intent));
    } catch (err) {
      await this.fail(a, target, err);
      this.sending = false;
      this.schedule();
      return;
    }
    this.lastSentAt = this.deps.now();
    a.last = { parent: ref, root: target?.root ?? ref };
    const index = a.index++;
    a.limitedUntil = undefined;
    const done = a.index >= a.item.posts.length;
    if (done && this.queue[0] === a) this.queue.shift();
    this.sending = false;
    try {
      this.deps.onSent(a.item, index, ref, target);
    } catch (err) {
      this.deps.onWarning(`Sent, but couldn't record it: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (done) await this.dropDraft(a);
    this.schedule();
  }

  /** The draft a retry replaces: it still holds posts that have since been dealt with. */
  private async dropDraft(a: Active): Promise<void> {
    if (a.draftId === undefined) return;
    await this.deps.deleteDraft(a.draftId).catch((err: unknown) => {
      this.deps.onWarning(
        `Couldn't delete draft ${a.draftId}, so it may send again on your next run: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private classify(err: unknown, a: Active): Classified {
    const e = err as { status?: number; error?: string; headers?: Record<string, string> };
    if (e.status === 429) {
      // ratelimit-reset is a Unix time in seconds.
      const ms = Number(e.headers?.["ratelimit-reset"]) * 1000 - this.deps.now();
      return a.limitedUntil === undefined && ms >= 0 && ms <= 60_000 ? { kind: "wait", ms } : { kind: "limited" };
    }
    if (e.status === 401 || e.error === "ExpiredToken" || e.error === "InvalidToken") return { kind: "expired" };
    // A 5xx says nothing about the post; only a 4xx rejects it.
    return isNetworkError(err) || (e.status ?? 0) >= 500 ? { kind: "network" } : { kind: "rejected" };
  }

  private async fail(a: Active, target: SendTarget | undefined, err: unknown): Promise<void> {
    const c = this.classify(err, a);
    if (c.kind === "wait") {
      a.limitedUntil = this.deps.now() + c.ms;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const failure: Failure = { kind: c.kind, item: a.item, from: a.index, target, message };
    if (c.kind === "rejected") {
      if (this.queue[0] === a) this.queue.shift();
      this.deps.onFailed(failure);
      await this.dropDraft(a);
      return;
    }
    this.failure = failure;
    const rest = a.item.posts.slice(a.index);
    try {
      const media = mediaFrom(a.item, a.index);
      const draft = await this.deps.saveDraft(draftOf("network", rest, { target, media, quote: quoteOf(a.item.intent) }));
      failure.draftId = draft.id;
      if (this.queue[0] === a) this.queue.shift();
      await this.dropDraft(a);
    } catch (saveErr) {
      // No draft, so the posts stay queued (paused) for /retry or Esc.
      failure.message = `${message}; couldn't save a draft either: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`;
      a.immediate = true;
    }
    this.deps.onFailed(failure);
  }
}
