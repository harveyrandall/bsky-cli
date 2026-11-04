import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Pipeline, type PipelineDeps, type SendTarget } from "./pipeline";
import type { AtUri, Cid, StrongRef } from "./types";

const ref = (n: number): StrongRef => ({
  uri: `at://did:plc:me/app.bsky.feed.post/3lbx7kt5def${String(n).padStart(2, "a")}` as AtUri,
  cid: `bafy${n}` as Cid,
});
const fetchFailed = () => Object.assign(new Error("fetch failed"), {});

function setup(o: { undo?: number; pace?: number } = {}) {
  let n = 0;
  let cursor: StrongRef | undefined;
  let root: StrongRef | undefined;
  const sent: { text: string; target?: SendTarget; at: number }[] = [];
  const deps = {
    now: () => Date.now(),
    setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimer: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
    send: vi.fn(async (text: string, target?: SendTarget) => {
      sent.push({ text, target, at: Date.now() });
      return ref(++n);
    }),
    threadTarget: () => (cursor && root ? { parent: cursor, root } : undefined),
    saveDraft: vi.fn(async () => ({ id: "d1" })),
    deleteDraft: vi.fn(async () => {}),
    settings: () => ({ undo: o.undo ?? 0, pace: o.pace ?? 0 }),
    onSent: vi.fn((item, _i, r: StrongRef, target?: SendTarget) => {
      if (item.intent.kind === "thread") {
        root ??= target?.root ?? r;
        cursor = r;
      }
    }),
    onChange: vi.fn(),
    onFailed: vi.fn(),
    onWarning: vi.fn(),
  } satisfies PipelineDeps;
  return { pipeline: new Pipeline(deps), deps, sent, start: Date.now() };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe("Pipeline timing", () => {
  it("waits for the undo window, then the pace since the last post", async () => {
    const { pipeline, sent } = setup({ undo: 5, pace: 10 });
    pipeline.enqueue({ kind: "standalone" }, ["a"]);
    expect(pipeline.countdown()).toMatchObject({ phase: "counting", sendAt: 5000 });
    await vi.advanceTimersByTimeAsync(5000);
    pipeline.enqueue({ kind: "standalone" }, ["b"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.map((s) => [s.text, s.at])).toEqual([["a", 5000], ["b", 15_000]]);
  });
  it("paces later posts of a batch, each replying to the one before", async () => {
    const { pipeline, sent } = setup({ pace: 5 });
    pipeline.enqueue({ kind: "standalone" }, ["a", "b", "c"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.map((s) => s.at)).toEqual([0, 5000, 10_000]);
    expect(sent[0].target).toBeUndefined();
    expect(sent[2].target).toEqual({ parent: ref(2), root: ref(1) });
  });
  it("shows the pacing phase once the undo window is over", async () => {
    const { pipeline } = setup({ undo: 5, pace: 15 });
    pipeline.enqueue({ kind: "standalone" }, ["a"]);
    await vi.advanceTimersByTimeAsync(5000);
    pipeline.enqueue({ kind: "standalone" }, ["b"]);
    await vi.advanceTimersByTimeAsync(6000);
    expect(pipeline.countdown()).toMatchObject({ phase: "pacing", sendAt: 20_000 });
  });
  it("sends now on request", async () => {
    const { pipeline, sent } = setup({ undo: 15 });
    pipeline.enqueue({ kind: "standalone" }, ["a"]);
    pipeline.sendNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
  });
  it("cancels everything still waiting", async () => {
    const { pipeline, deps } = setup({ undo: 5 });
    pipeline.enqueue({ kind: "standalone" }, ["a"]);
    pipeline.enqueue({ kind: "thread" }, ["b", "c"]);
    expect(pipeline.cancelAll().map((i) => i.posts)).toEqual([["a"], ["b", "c"]]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(deps.send).not.toHaveBeenCalled();
    expect(pipeline.pending()).toEqual([]);
  });
  it("doesn't resend a post that was in flight when everything was cancelled", async () => {
    const { pipeline, deps, sent } = setup();
    let release = () => {};
    deps.send.mockImplementationOnce(async (text: string) => {
      await new Promise<void>((resolve) => (release = resolve));
      sent.push({ text, at: Date.now() });
      return ref(1);
    });
    pipeline.enqueue({ kind: "thread" }, ["a", "b", "c"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(pipeline.cancelAll().map((i) => i.posts)).toEqual([["b", "c"]]);
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.map((s) => s.text)).toEqual(["a"]);
    expect(pipeline.pending()).toEqual([]);
  });
  it("drafts only the in-flight post when it fails after a cancel", async () => {
    const { pipeline, deps } = setup();
    let fail = () => {};
    deps.send.mockImplementationOnce(
      () => new Promise<StrongRef>((_resolve, reject) => (fail = () => reject(fetchFailed()))),
    );
    pipeline.enqueue({ kind: "standalone" }, ["a", "b"]);
    await vi.advanceTimersByTimeAsync(0);
    pipeline.cancelAll();
    fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.saveDraft).toHaveBeenCalledWith({ reason: "network", type: "post", text: "a" });
  });
  it("resolves parents at send time", async () => {
    const { pipeline, sent } = setup({ undo: 5 });
    pipeline.enqueue({ kind: "thread" }, ["root"]);
    pipeline.enqueue({ kind: "thread" }, ["second"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent[1].target).toEqual({ parent: ref(1), root: ref(1) });
  });
  it("replies to a fixed target for a reply intent", async () => {
    const { pipeline, sent } = setup();
    pipeline.enqueue({ kind: "reply", target: ref(9), root: ref(8) }, ["x", "y"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((s) => s.target)).toEqual([{ parent: ref(9), root: ref(8) }, { parent: ref(1), root: ref(8) }]);
  });
});

describe("Pipeline errors", () => {
  it("saves the rest of a failed batch as one draft", async () => {
    const { pipeline, deps } = setup();
    deps.send.mockResolvedValueOnce(ref(1)).mockRejectedValueOnce(fetchFailed());
    pipeline.enqueue({ kind: "thread" }, ["one", "two", "three"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.saveDraft).toHaveBeenCalledWith({
      reason: "network",
      type: "thread",
      text: "two",
      replyUri: ref(1).uri,
      posts: [{ text: "two" }, { text: "three" }],
    });
    expect(deps.onSent).toHaveBeenCalledOnce();
    expect(deps.onFailed).toHaveBeenCalledWith(expect.objectContaining({ kind: "network", from: 1, draftId: "d1" }));
  });
  it("pauses the queue after a network failure until /retry, which deletes the draft on success", async () => {
    const { pipeline, deps, sent } = setup();
    deps.send.mockRejectedValueOnce(fetchFailed());
    pipeline.enqueue({ kind: "standalone" }, ["a"]);
    pipeline.enqueue({ kind: "standalone" }, ["b"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toEqual([]);
    expect(pipeline.pending()).toHaveLength(1);
    await expect(pipeline.retry()).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((s) => s.text)).toEqual(["a", "b"]);
    expect(deps.deleteDraft).toHaveBeenCalledWith("d1");
  });
  it("keeps a retried thread a thread, so its posts still move the cursor", async () => {
    const { pipeline, deps, sent } = setup();
    deps.send.mockResolvedValueOnce(ref(9)).mockRejectedValueOnce(fetchFailed());
    pipeline.enqueue({ kind: "thread" }, ["one", "two", "three"]);
    await vi.advanceTimersByTimeAsync(0);
    await pipeline.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((s) => [s.text, s.target?.parent.uri])).toEqual([
      ["two", ref(9).uri],
      ["three", ref(1).uri],
    ]);
    expect(deps.onSent.mock.calls.map(([item]) => item.intent.kind)).toEqual(["thread", "thread", "thread"]);
  });
  it("retries to the parent the post failed on, even if the thread has moved since", async () => {
    const { pipeline, deps, sent } = setup();
    const parent = { parent: ref(7), root: ref(6) };
    const threadTarget = vi.spyOn(deps, "threadTarget").mockReturnValue(parent);
    deps.send.mockRejectedValueOnce(fetchFailed());
    pipeline.enqueue({ kind: "thread" }, ["one"]);
    await vi.advanceTimersByTimeAsync(0);
    threadTarget.mockReturnValue({ parent: ref(8), root: ref(8) });
    await pipeline.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((s) => s.target)).toEqual([parent]);
  });
  it("forgets a paused failure when the queue is cancelled", async () => {
    const { pipeline, deps } = setup();
    deps.send.mockRejectedValueOnce(fetchFailed());
    pipeline.enqueue({ kind: "standalone" }, ["a"]);
    await vi.advanceTimersByTimeAsync(0);
    pipeline.cancelAll();
    expect(pipeline.isPaused()).toBe(false);
    expect(pipeline.lastFailure()).toBeUndefined();
    await expect(pipeline.retry()).resolves.toBe(false);
  });
  it("keeps a post it couldn't save as a draft at the head of the paused queue", async () => {
    const { pipeline, deps, sent } = setup();
    deps.send.mockRejectedValueOnce(fetchFailed());
    deps.saveDraft.mockRejectedValueOnce(new Error("EACCES: permission denied"));
    pipeline.enqueue({ kind: "standalone" }, ["a"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.onFailed).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "network", message: expect.stringContaining("EACCES") }),
    );
    expect(deps.onFailed.mock.calls[0][0].draftId).toBeUndefined();
    expect(pipeline.isPaused()).toBe(true);
    expect(pipeline.pending().map((i) => i.posts)).toEqual([["a"]]);
    await pipeline.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((s) => s.text)).toEqual(["a"]);
  });
  it("treats a draft it can't delete after a retry as a warning, and carries on with the queue", async () => {
    const { pipeline, deps, sent } = setup();
    deps.send.mockRejectedValueOnce(fetchFailed());
    deps.deleteDraft.mockRejectedValueOnce(new Error("ENOENT"));
    pipeline.enqueue({ kind: "standalone" }, ["a"]);
    pipeline.enqueue({ kind: "standalone" }, ["b"]);
    await vi.advanceTimersByTimeAsync(0);
    await pipeline.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((s) => s.text)).toEqual(["a", "b"]);
    expect(deps.onFailed).toHaveBeenCalledOnce();
    expect(deps.onWarning).toHaveBeenCalledWith("Couldn't delete draft d1, so it may send again on your next run: ENOENT");
  });
  it("replaces the old draft when a retry fails again, so sent posts can't go out twice", async () => {
    const { pipeline, deps } = setup();
    deps.send.mockRejectedValueOnce(fetchFailed());
    pipeline.enqueue({ kind: "thread" }, ["one", "two"]);
    await vi.advanceTimersByTimeAsync(0);
    deps.saveDraft.mockResolvedValueOnce({ id: "d2" });
    deps.send.mockResolvedValueOnce(ref(1)).mockRejectedValueOnce(fetchFailed());
    await pipeline.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.onFailed).toHaveBeenLastCalledWith(expect.objectContaining({ draftId: "d2" }));
    expect(deps.deleteDraft).toHaveBeenCalledExactlyOnceWith("d1");
  });
  it("keeps the old draft when a failed retry can't save a new one", async () => {
    const { pipeline, deps, sent } = setup();
    deps.send.mockRejectedValueOnce(fetchFailed());
    pipeline.enqueue({ kind: "standalone" }, ["a"]);
    await vi.advanceTimersByTimeAsync(0);
    deps.saveDraft.mockRejectedValueOnce(new Error("EACCES"));
    deps.send.mockRejectedValueOnce(fetchFailed());
    await pipeline.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.deleteDraft).not.toHaveBeenCalled();
    await pipeline.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((s) => s.text)).toEqual(["a"]);
    expect(deps.deleteDraft).toHaveBeenCalledExactlyOnceWith("d1");
  });
  it("deletes the old draft when the server rejects a retry: the text goes back to the composer", async () => {
    const { pipeline, deps } = setup();
    deps.send.mockRejectedValueOnce(fetchFailed());
    pipeline.enqueue({ kind: "standalone" }, ["a"]);
    await vi.advanceTimersByTimeAsync(0);
    deps.send.mockRejectedValueOnce(new Error("Record too large"));
    await pipeline.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.onFailed).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "rejected" }));
    expect(deps.deleteDraft).toHaveBeenCalledExactlyOnceWith("d1");
  });
  it("doesn't call a sent post failed when recording it throws", async () => {
    const { pipeline, deps, sent } = setup();
    deps.onSent.mockImplementationOnce(() => {
      throw new Error("bookkeeping broke");
    });
    pipeline.enqueue({ kind: "standalone" }, ["a", "b"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((s) => s.text)).toEqual(["a", "b"]);
    expect(deps.onFailed).not.toHaveBeenCalled();
    expect(deps.onWarning).toHaveBeenCalledWith(expect.stringContaining("bookkeeping broke"));
  });
  it("retries once after a rate limit that resets within a minute", async () => {
    const { pipeline, deps, sent } = setup();
    deps.send.mockRejectedValueOnce(Object.assign(new Error("Rate Limit Exceeded"), { status: 429, headers: { "ratelimit-reset": "2" } }));
    pipeline.enqueue({ kind: "standalone" }, ["a"]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent.map((s) => [s.text, s.at])).toEqual([["a", 2000]]);
  });
  it("treats a long rate limit like a network failure", async () => {
    const { pipeline, deps } = setup();
    deps.send.mockRejectedValueOnce(Object.assign(new Error("Rate Limit Exceeded"), { status: 429, headers: { "ratelimit-reset": "120" } }));
    pipeline.enqueue({ kind: "standalone" }, ["a"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.onFailed).toHaveBeenCalledWith(expect.objectContaining({ kind: "network" }));
  });
  it("reports an expired session and keeps the text as a draft", async () => {
    const { pipeline, deps } = setup();
    deps.send.mockRejectedValueOnce(Object.assign(new Error("Token has expired"), { status: 401, error: "ExpiredToken" }));
    pipeline.enqueue({ kind: "standalone" }, ["a"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ type: "post", text: "a" }));
    expect(deps.onFailed).toHaveBeenCalledWith(expect.objectContaining({ kind: "expired" }));
  });
  it("hands a rejected post back without a draft and carries on with the queue", async () => {
    const { pipeline, deps, sent } = setup();
    deps.send.mockRejectedValueOnce(Object.assign(new Error("Record/text must not be longer than 300 graphemes"), { status: 400 }));
    pipeline.enqueue({ kind: "standalone" }, ["too long"]);
    pipeline.enqueue({ kind: "standalone" }, ["fine"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.saveDraft).not.toHaveBeenCalled();
    expect(deps.onFailed).toHaveBeenCalledWith(expect.objectContaining({ kind: "rejected", from: 0 }));
    expect(sent.map((s) => s.text)).toEqual(["fine"]);
  });
});
