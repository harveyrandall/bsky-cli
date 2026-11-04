# `bsky repl` PR 2 (Threading) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A full thread can be written end to end in `bsky repl` — start, continue, branch with `/reply` and `/reply-from`, standalone posts, undo window and pacing, split preview, errors that never lose text — and bare `bsky` in a terminal opens the REPL (issue #21).

**Architecture:** All behaviour lives in UI-free `src/repl/core/`: guarded types, a submit parser on top of PR 1's marker scanner, a post registry with ref resolution, a timer-injected send pipeline, and a `Repl` controller that owns mode, thread and settings. The controller talks to the network only through an injected `ReplAgent` and asks the user only through injected `ReplAsk` callbacks, so every flow is unit-tested with fakes. Ink components render controller state and answer its questions with small overlays.

**Tech Stack:** as PR 1, plus `@atproto/syntax@^0.5.2` (already installed through `@atproto/api`; made explicit because the guards import it).

**Spec:** `docs/superpowers/specs/2026-10-31-bsky-repl-design.md` §4, §5, §6 (ring limit), §7, §9, §10, §11, §12 (types and exit summary only), §13 (PR 2 commands), §17 PR 2 row.

## Where this plan departs from the spec

| Spec | This plan | Why |
|---|---|---|
| `isSessionId`, `Marker` brand, `ViewedLabel` guards in `types.ts` | Added with their first users (PR 4 resume, PR 5 `#n`) | No unused code; PR 1 already guards markers in `resolveMarkers`. |
| `core/session.ts` holds `toJSON/fromJSON` | PR 4 | Persistence lands with resume. |
| Deletes, `/switch`, `/undo` | PR 5 (§17) | Registry has no `deleted` flag yet. |
| Choice prompts use `@inkjs/ui` | A ~40-line `Choice` component | `@inkjs/ui` still arrives with `NewMenu` in PR 3; the prompts here are one-line pickers. |
| Ctrl+D double-press (PR 1 stopgap) | Replaced by §10's exit prompt `[s]end now · save [d]raft · discard [x] · [Esc] stay` | The spec's behaviour now that posting exists. |

## Global Constraints

- Everything in PR 1's Global Constraints still holds (Node ≥ 22 via `PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"`, Yarn only, `core/` never imports `ink`/`react`, only `src/commands/repl.ts` imports `@/repl`, Bun must work, signed commits).
- `core/` never imports `@/index` or `@/commands/*` (they pull in the CLI entry). Network calls go through `ReplAgent`; drafts through injected `saveDraft`/`deleteDraft`.
- New dependency: `@atproto/syntax@^0.5.2` only.
- Exact copy:
  - prompts `bsky ›`, `thread ›` (no posts yet), `thread (4) ›`, `thread A (A4) ›`, `reply→2 ›`, `post ›`
  - countdown `Sending in 7s… [Esc] cancel  [Enter] send now`
  - post line `(4) 3lbx7kt5def2v`; verbose adds ` (at://…)`; suffixes ` ↳ 1` when the parent isn't the previous post, ` ext @alice.bsky.social` for external targets
  - `Thread stopped (5 posts, root (1) 3lbx…)` (rkey shortened to 4 chars + `…`)
  - `Wait for pending posts, or Esc to cancel them`
  - `Can't resolve "<x>": use a number, #n, rkey, at:// URI or bsky.app link`
  - cooldown question `Undo window before each post?` / `Minimum time between posts?` with choices `none 5s 10s 15s`
  - save offer `Save undo 5s · pace off as your defaults in config.toml?` with `Yes  No  No, don't ask again` (only the asked values appear; `0` reads `off`)
  - `Post 3? [y/N]`, `Kept for next: …`, `Discarded: …`
  - `Session expired — exit and run \`bsky login\``
  - exit summary `7 posts in 2 threads` (PR 4 adds the resume hint)
- Thread label: `\n🧵` appended (or `🧵\n` prepended); 2 graphemes; limit 298 for labelled posts.
- `[y/N]` always defaults to No.

## Review Focus

1. Two quick Enters while an item is still counting down must queue the second behind the first and send it as a reply to the first's post, not to the old cursor. Test: Task 5 "resolves parents at send time".
2. A network failure mid-batch must save the failed post and every later post of that batch as one draft and leave the cursor where it was. Test: Task 5 "saves the rest of a failed batch as one draft".
3. Text never disappears: preview No/Esc, a rejected record, cancelling pending items and the exit prompt's discard path are the only ways text leaves the composer, and the first three put it back. Tests: Task 6 "puts text back" cases.
4. `/thread 42` with a ref continues that thread; `/thread "42"` posts the text `42`. Test: Task 6 "/thread argument forms".
5. Bare `bsky` without a terminal prints the program's help and exits 1, as before; `bsky repl` without one keeps PR 1's message. Test: Task 8 `it.each`.

---

### Task 1: Guarded types

**Files:** Create `src/repl/core/types.ts`; Test `src/repl/core/types.test.ts`; Modify `package.json`/`yarn.lock` (`yarn add @atproto/syntax@^0.5.2`).

**Interfaces — Produces:**

```ts
export type Did = `did:plc:${string}` | `did:web:${string}`;
export type Handle = `${string}.${string}`;
export type AtUri = `at://${Did}/app.bsky.feed.post/${string}`;
export type Cid = `b${string}`;
export type Rkey = string & { readonly __brand: "Rkey" };
export type ThreadLetter = Uppercase<string>;
type Upper = Uppercase<string>;
export type OwnLabel = `${number}` | `${Upper}${number}` | `${Upper}${Upper}${number}` | `${Upper}${Upper}${Upper}${number}`;
export type Cooldown = 0 | 5 | 10 | 15;
export interface StrongRef { uri: AtUri; cid: Cid }
export function isDid(v: unknown): v is Did;      // isValidDid, plc/web only
export function isHandle(v: unknown): v is Handle; // isValidHandle
export function isRkey(v: unknown): v is Rkey;    // isValidTid
export function isAtUri(v: unknown): v is AtUri;  // new AtUri(v): DID host, collection app.bsky.feed.post, rkey a TID
export function isCid(v: unknown): v is Cid;      // /^b[a-z2-7]+$/
export function isOwnLabel(v: unknown): v is OwnLabel; // /^(\d+|[A-Z]{1,3}\d+)$/
export function isCooldown(v: unknown): v is Cooldown;
export function rkeyOf(uri: AtUri): Rkey;
export function toStrongRef(res: { uri: string; cid: string }): StrongRef; // throws `Unexpected post reference from the server: …`
```

- [ ] **Step 1: failing tests** — accept/reject tables per guard (`it.each`), e.g. `isAtUri("at://did:plc:abc/app.bsky.feed.post/3lbx7kt5def2v")` true; `…/app.bsky.feed.like/3lbx…`, handle authority, non-TID rkey all false; `isCid("bafyrei…")` true, `"Qm…"` false; `isOwnLabel("AA3")` true, `"a3"` false, `"#3"` false; `isCooldown(5)` true, `7`/`"5"` false; `toStrongRef({ uri: "x", cid: "y" })` throws; `rkeyOf(uri)` returns the last segment.
- [ ] **Step 2:** run `yarn vitest run src/repl/core/types.test.ts` → FAIL (module missing).
- [ ] **Step 3:** implement with `@atproto/syntax` (`isValidDid`, `isValidHandle`, `isValidTid`, `AtUri`); `as` casts only inside guards.
- [ ] **Step 4:** run → PASS. **Step 5:** commit `feat(repl): add guarded types for posts, labels and cooldowns`.

### Task 2: Submit parser

**Files:** Modify `src/repl/core/markers.ts`; Test `src/repl/core/markers.test.ts`.

**Interfaces — Consumes:** `scanMarkers`, `Markers` (PR 1); `splitThread`, `graphemeLength` (`@/lib/split-thread`). **Produces:**

```ts
export interface SubmitPlan {
  posts: string[];          // trimmed, empty pieces dropped
  keep?: string;            // after the first send marker, untrimmed except leading whitespace
  discard?: string;         // after the first cut marker in the send part
  autoSplit: boolean;       // no split markers and the text was over `limit`
  markersUsed: boolean;
  overLimit: number[];      // indexes of marker-made posts longer than `limit`
}
export function parseSubmit(text: string, m: Markers, limit: number): SubmitPlan;
```

- [ ] **Step 1: failing tests** — order (`a //> b <// c` → posts `["a"]`, keep `"b <// c"`, no discard); `a <// b //> c` → discard `"b"`, keep `"c"`; `one /// two ///` → `["one","two"]`; escapes removed (`file:\///tmp` → `["file:///tmp"]`); a 350-grapheme text without markers → `autoSplit` true and every post ≤ limit; `limit` 298 honoured; a marker-made 320-grapheme piece → `overLimit: [i]` and no auto-split; custom markers.
- [ ] **Step 2–4:** red, implement (regions from `scanMarkers`, unescape per piece, auto-split via `splitThread(text, { splitMarker: false, maxChars: limit, threadLabel: false })`), green.
- [ ] **Step 5:** commit `feat(repl): parse submitted text into posts, kept and discarded parts`.

### Task 3: Registry and refs

**Files:** Create `src/repl/core/refs.ts`; Test `src/repl/core/refs.test.ts`.

**Interfaces — Consumes:** Task 1 types. **Produces:**

```ts
export interface RegistryEntry {
  label: OwnLabel; uri: AtUri; cid: Cid; rkey: Rkey; authorDid: Did;
  root: StrongRef; parent?: AtUri; excerpt: string; external?: Handle; letter?: ThreadLetter;
}
export interface PostLookup { uri: AtUri; cid: Cid; authorDid: Did; authorHandle: Handle; text: string; root?: StrongRef; parent?: StrongRef }
export interface RefAgent {
  selfDid: Did;
  resolveHandle(handle: string): Promise<Did>;
  getPosts(uris: AtUri[]): Promise<PostLookup[]>;
}
export class Registry {
  constructor(prefixed: boolean);
  readonly prefixed: boolean;
  newLetter(): ThreadLetter;                    // A…Z, AA…; prefixed mode only
  addOwn(ref: StrongRef, o: { root: StrongRef; parent?: AtUri; text: string; letter?: ThreadLetter }): RegistryEntry;
  addExternal(post: PostLookup, o: { letter?: ThreadLetter; startsThread?: boolean }): RegistryEntry;
  byLabel(label: OwnLabel): RegistryEntry | undefined;
  byUri(uri: AtUri): RegistryEntry | undefined;
  entries(): readonly RegistryEntry[];
}
export interface ResolvedRef { ref: StrongRef; root: StrongRef; entry?: RegistryEntry; post?: PostLookup }
export async function resolveRef(input: string, r: { registry: Registry; agent: RefAgent; letter?: ThreadLetter }): Promise<ResolvedRef>; // throws the exact "Can't resolve" copy, or `"A3" is a prefixed label; start the REPL with -l to use them`
export function formatEntry(e: RegistryEntry, o: { verbose: boolean; previous?: RegistryEntry }): string;
```

- Session-wide labels `1, 2, 3…` across everything. Prefixed: each thread and each standalone post takes `newLetter()`; numbers count within the letter from 1; an external that starts a prefixed thread is `<letter>0`; other externals take the next number in the current letter (a new letter when idle). A bare number in prefixed mode resolves within `letter` (the current thread, else the last letter used).
- Ref order (§5): own label → prefixed label → `#n` (error `#n labels arrive with viewed posts`, PR 5) → `at://` (handle authority → `resolveHandle`) → `https://bsky.app/profile/<h|did>/post/<rkey>` → bare TID in `selfDid`'s repo. URIs not in the registry are fetched with one `getPosts` call; the result's `root` (or the post itself) is the thread root.
- `excerpt`: first line, 40 graphemes, `…` when cut.

- [ ] **Step 1: failing tests** — numbering in both modes (incl. `A0` external starting a thread, `AA` after `Z`); every ref form with a fake `RefAgent` (handle → DID; bsky.app link with handle and with DID; bare rkey uses `selfDid`; registry hit makes no network call); errors with exact copy; `formatEntry` plain, verbose, `↳ 1`, `ext @alice.bsky.social`.
- [ ] **Step 2–4:** red, implement, green. **Step 5:** commit `feat(repl): number posts and resolve post references`.

### Task 4: `setConfigValues` and the active config path

**Files:** Modify `src/toml-config.ts`, `src/index.ts` (use `activeConfigPath`); Test `src/toml-config.test.ts`.

**Interfaces — Produces:**

```ts
export function activeConfigPath(argv?: string[]): string; // -c/--config › BSKY_CONFIG › default (moves preParseConfigPath out of index.ts)
export function setConfigValues(path: string, section: string, values: Record<string, string | number | boolean>): Promise<void>;
```

Line-based upsert per spec §4: inside `[section]` replace `key = …` or uncomment `# key = …`, else insert after the header; append the section if missing; create the file from `generateDefaultConfig()` if absent; re-parse with `smol-toml` and write via temp file + rename; throw (leaving the file untouched) if the result doesn't parse. Values are written as TOML literals (`5`, `true`, `"x"`).

- [ ] **Step 1: failing tests** (tmp dir) — replaces a value; uncomments `# undo = 5`; inserts into an existing `[repl]`; appends a missing `[repl]`; creates the file from the default config; other sections and every comment byte-for-byte intact; refuses unparseable output (e.g. a section header injected through a value is impossible because values are serialised, so test with a pre-broken file: it throws and the file is unchanged); `activeConfigPath(["node","bsky","-c","/x.toml"])` → `/x.toml`.
- [ ] **Step 2–4:** red, implement, green. **Step 5:** commit `feat(config): add comment-preserving setConfigValues`.

### Task 5: Send pipeline

**Files:** Create `src/repl/core/pipeline.ts`; Test `src/repl/core/pipeline.test.ts`.

**Interfaces — Consumes:** Task 1 types; `Draft` (`@/lib/types`). **Produces:**

```ts
export type Intent = { kind: "thread" } | { kind: "reply"; target: StrongRef; root: StrongRef } | { kind: "standalone" };
export interface QueueItem { id: number; intent: Intent; posts: string[]; createdAt: number }
export type Phase = "counting" | "pacing" | "sending";
export interface Countdown { item: QueueItem; phase: Phase; sendAt: number }
export interface SendTarget { parent: StrongRef; root: StrongRef }
export interface PipelineDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  send(text: string, reply?: SendTarget): Promise<StrongRef>;
  threadTarget(): SendTarget | undefined;          // read at send time
  saveDraft(d: Omit<Draft, "id" | "createdAt">): Promise<{ id: string }>;
  deleteDraft(id: string): Promise<void>;
  settings(): { undo: number; pace: number };
  onSent(item: QueueItem, index: number, ref: StrongRef, target: SendTarget | undefined): void;
  onChange(): void;
  onFailed(f: Failure): void;
}
export interface Failure { kind: "network" | "rejected" | "expired"; item: QueueItem; from: number; message: string; draftId?: string }
export class Pipeline {
  constructor(deps: PipelineDeps);
  enqueue(intent: Intent, posts: string[]): QueueItem;
  pending(): readonly QueueItem[];
  countdown(): Countdown | undefined;
  sendNow(): void;                  // skip the current wait
  cancelAll(): QueueItem[];         // returns cancelled items, oldest first
  retry(): Promise<boolean>;        // resend the last network failure; deletes its draft on success
  lastFailure(): Failure | undefined;
}
```

- First post of an item sends at `max(now + undo, lastSentAt + pace)`; later posts at `lastSentAt + pace`. Phase is `counting` while `now < enqueuedAt + undo`, then `pacing`, then `sending`.
- `thread` intent: parent is `threadTarget()` at send time; posts after the first in a batch reply to the previous one. `reply`: first reply to `target`, later chain. `standalone`: first has no parent, later chain under it.
- Errors: `isNetworkError`-style (`fetch failed`, `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT` in message or cause) → save the failed post and the rest of the batch as one draft (`reason: "network"`, `type` `thread` when > 1 post else `reply`/`post`, `replyUri` = parent URI), stop the queue, `onFailed`. HTTP 429 with `ratelimit-reset` ≤ 60 s ahead → wait and retry once, else as network. `status` 401 / `ExpiredToken` → `expired`. Anything else → `rejected` (no draft; the controller puts the text back).

- [ ] **Step 1: failing tests** (fake clock/timers) — `max(undo, pace)` for the first post; batch pacing; `cancelAll` during counting; `sendNow`; **resolves parents at send time** (enqueue A then B; A's sent ref becomes B's parent via `threadTarget`); **saves the rest of a failed batch as one draft** (3-post batch, post 2 fails with `fetch failed` → draft `type: "thread"`, 2 posts, `replyUri` = post 1's URI; cursor callback not called for post 2); 429 retried once after the reset; 429 with reset > 60 s → network path; 401 → expired; other errors → rejected without a draft; `retry()` sends the rest and deletes the draft.
- [ ] **Step 2–4:** red, implement, green. **Step 5:** commit `feat(repl): add a send queue with undo window, pacing and error handling`.

### Task 6: The `Repl` controller

**Files:** Create `src/repl/core/repl.ts`, `src/repl/core/summary.ts`; Test `src/repl/core/repl.test.ts`, `src/repl/core/summary.test.ts`.

**Interfaces — Consumes:** Tasks 1–5; `dispatch`'s `DispatchResult`. **Produces:**

```ts
export type ReplMode =
  | { kind: "idle" } | { kind: "thread" }
  | { kind: "reply-once"; target: ResolvedRef; label: string; returnTo: "idle" | "thread" }
  | { kind: "post-once"; returnTo: "idle" | "thread" };
export interface ReplSettings {
  autoThread: boolean; prefixThread: boolean; threadLabel: false | "append" | "prepend";
  undo?: Cooldown; pace?: Cooldown; askToSave: boolean; verbose: boolean;
}
export interface ReplAsk {
  cooldown(kind: "undo" | "pace"): Promise<Cooldown | undefined>;      // undefined = Esc
  saveOffer(values: { undo?: Cooldown; pace?: Cooldown }): Promise<"yes" | "no" | "never">;
  confirm(plan: SubmitPlan, labelled: boolean): Promise<boolean>;      // preview; default No
}
export interface ReplDeps {
  agent: RefAgent & { post(text: string, reply?: SendTarget): Promise<StrongRef> };
  ask: ReplAsk; print(text: string, style?: LineStyle): void; onChange(): void;
  restore(text: string): void;                     // put text back in the composer (async failures)
  saveDraft: PipelineDeps["saveDraft"]; deleteDraft: PipelineDeps["deleteDraft"];
  saveConfig(values: Record<string, string | number | boolean>): Promise<void>;
  timers?: Pick<PipelineDeps, "now" | "setTimer" | "clearTimer">;
}
export type SubmitOutcome = "done" | "keep" | { restore: string };  // restore: put this text in the composer
export class Repl {
  constructor(settings: ReplSettings, markers: Markers, deps: ReplDeps);
  readonly registry: Registry; readonly pipeline: Pipeline;
  mode(): ReplMode; settings(): ReplSettings; thread(): ThreadState | undefined;
  prompt(): string;                                   // exact copy above
  limitFor(intent: "thread" | "reply" | "standalone"): 298 | 300;
  submitText(text: string): Promise<SubmitOutcome>;   // plain text in the current mode
  startThread(arg?: string, opts?: { undo?: Cooldown; pace?: Cooldown }): Promise<SubmitOutcome>;
  reply(ref: string, text?: string): Promise<SubmitOutcome>;
  replyFrom(ref: string): Promise<void>;
  post(text?: string): Promise<SubmitOutcome>;
  setAutoThread(on?: boolean): void;
  setCooldown(kind: "undo" | "pace", value: Cooldown): void;
  escape(): "handled" | "unhandled";                  // §10 layers below overlays
  interrupt(hasText: boolean): "clear" | "handled" | "hint";
  wouldLose(composerText: string): boolean;
  failures(): Failure[];
}
export interface ThreadState { root: StrongRef; cursor: StrongRef; letter?: ThreadLetter; count: number }
// summary.ts
export function exitSummary(r: { registry: Registry; failures: Failure[]; verbose: boolean; startedAt: Date; endedAt: Date; handle: string }): string[];
```

Behaviour (spec §5, §7, §9, §10, §11):
- `submitText`: idle → `keep` with the `TEXT_HINT` replaced by `Plain text needs a thread: /thread to start one, /post for a single post, or -t to do this automatically.` unless `autoThread`, which starts a thread with the text; thread → next post in thread; reply-once → reply then return; post-once → standalone then return.
- Every write goes through `parseSubmit` with `limitFor`. Direct (one post, ≤ limit, no markers) → pipeline; otherwise `ask.confirm`; No → `{ restore: text }`; Yes → enqueue, then `{ restore: keep }` (or `"done"`), and print `Discarded: …` dimmed once. `overLimit` non-empty → print the posts with the red one marked and `{ restore: text }`.
- Thread label: posts of the active thread (root, continuations, `/reply` whose root is the thread root) get the label; the preview shows labelled text.
- First thread of a session with `undo`/`pace` unset: ask each (Esc → cancel, text restored), then unless `askToSave` is false offer to save; `yes` → `saveConfig({ undo, pace })` of the asked values only; `never` → `saveConfig({ "ask-to-save": false })`.
- `/thread` arg: none → thread mode; whole arg resolves as a ref → continue that thread (`root` from the ref); otherwise text of the first post (quotes force text — the dispatcher already removed them, so `/thread "42"` arrives as a single token marked `quoted`; see Task 7).
- Cursor-changing calls while `pipeline.pending()` is non-empty print `Wait for pending posts, or Esc to cancel them` and return `keep`.
- `onSent`: register, print `formatEntry`, advance cursor (thread intent), first post of a thread intent with no thread sets `root`.
- Failures: network → print `Couldn't reach Bluesky; saved as draft <id>. /retry to send it now.`; rejected → print the error and `deps.restore` the failed post and the rest of its batch joined with ` /// `; expired → print the expired copy.
- `escape()`: pending → `cancelAll`, text of cancelled items restored if the composer is empty else saved as a draft (id printed); once-modes → back; thread → stop thread printing the stopped copy. `interrupt`: text → `clear`; else as `escape` for thread/pending; idle → `hint`.
- Exit summary: normal `N posts in M threads` (+ `, K standalone`), verbose adds per-thread lines via `formatEntry` with URIs, start–end and duration, handle, failures with draft ids.

- [ ] **Step 1: failing tests** (fake agent, fake ask, fake timers) — idle hint vs auto-thread; thread end to end (root then replies, prompt `thread (2) ›`, cursor advances); `/reply` once-mode returns; `/reply-from` moves the cursor; **"/thread argument forms"** (`42` resolving, `"42"` quoted as text, free text); **"puts text back"** for preview No, rejected record, cancel pending with empty composer; preview default No; over-limit marker segment; thread label applied only inside the active thread and limit 298; cooldown ask + save offer (yes/no/never, not shown when configured or `askToSave` false); pending blocks cursor changes; Esc/Ctrl+C layers; summary normal and verbose.
- [ ] **Step 2–4:** red, implement, green. **Step 5:** commit `feat(repl): add the session controller for threads, replies and posts`.

### Task 7: Commands

**Files:** Modify `src/repl/core/commands.ts` (registry gains the new commands; `CommandContext` gains `repl: Repl` and `restore(text)`), `src/repl/core/dispatch.ts` (pass quoting info), tests.

**Interfaces — Produces:** `CommandContext { print; exit; repl: Repl; restore(text: string): void }`; `tokenize` gains `tokenizeWithQuotes(input): { value: string; quoted: boolean }[]` used by `/thread`.

Commands (usage, summary):
- `/thread [text|ref] [--undo N] [--pace N]` — `Start or continue a thread`
- `/reply <ref> [text]` — `Reply once to a post`
- `/reply-from <ref>` — `Continue the thread from another post`
- `/post [text]` — `Post on its own`
- `/auto-thread [on|off]` — `Toggle starting a thread from plain text`
- `/settings [undo|pace N]` — `Show or change undo and pace`
- `/history` — `List this session's posts`
- `/retry` — `Resend the last batch that failed`

- [ ] **Step 1: failing tests** (fake `Repl` methods via `vi.fn`) — each command calls the right controller method with parsed args; `--undo 7` rejected with `must be 0, 5, 10 or 15`; `/settings` with no args asks undo then pace through `ask.cooldown` (Esc keeps the current value) and prints `undo 5s · pace off · auto-thread off`; `/settings undo 10` sets it directly; `/history` prints `formatEntry` lines; `/help` lists all ten commands; `completeCommand` completes `/rep` to `/reply` and lists `reply  reply-from` for `/reply`.
- [ ] **Step 2–4:** red, implement, green. **Step 5:** commit `feat(repl): add /thread, /reply, /reply-from, /post, /auto-thread, /settings, /history and /retry`.

### Task 8: UI wiring, overlays and key routing

**Files:** Create `src/repl/ui/Choice.tsx`, `src/repl/ui/SplitPreview.tsx`, `src/repl/ui/Countdown.tsx`, `src/repl/ui/ExitPrompt.tsx`; Modify `src/repl/ui/App.tsx`, `src/repl/ui/Composer.tsx`, `src/repl/index.tsx`, `src/commands/repl.ts`; Tests `src/repl/ui/*.test.tsx`, `src/commands/repl.test.ts`, `src/repl/start.test.tsx`.

**Interfaces — Consumes:** `Repl`, `ReplAsk`, `exitSummary`. **Produces:** `ReplOptions { markers; settings: ReplSettings; agent: ReplDeps["agent"]; handle: string; configPath: string }`; `startRepl` prints `exitSummary` to stdout after Ink exits.

- App creates one `Repl`, implements `ReplAsk` with overlay state (a promise resolver per question), passes `onChange` → rerender.
- Composer: prompt from `repl.prompt()`; ring `limit` from `repl.limitFor`; while the countdown is `counting`, the pending text shows dimmed and read-only and Enter = send now, Esc = cancel; Countdown line under the composer.
- Key routing (§10), innermost first: overlay (Esc/Ctrl+C close, preview text back) → pending → once-modes → composer text (Ctrl+C clears) → thread (stop) → idle (Ctrl+C hint). Ctrl+D: if `repl.wouldLose(text)` → ExitPrompt `[s]end now · save [d]raft · discard [x] · [Esc] stay`; `s` sends pending immediately and exits when the queue drains, `d` saves composer text and pending items as drafts (ids printed), `x` exits.
- `src/commands/repl.ts`: `program.command("repl", { isDefault: true })`; on a non-TTY start, bare `bsky` (no `repl` operand in `program.args`) calls `program.help({ error: true })`; `bsky repl` keeps PR 1's message. After the TTY check: `getClient(program)` (errors print and exit 1 through the CLI's catch), build `ReplSettings` from opts (`threadLabel` from `--thread-label`/`--prepend-thread-label`, `verbose` from `program.opts().verbose`, `askToSave` from config `ask-to-save`), `activeConfigPath()`, `agent.session.handle`. The unused-flag note now covers only `-f`, `-r`, `--resumable`/`-R`.

- [ ] **Step 1: failing tests** — App: thread end to end with a fake agent through real keystrokes (prompt changes, post lines printed, countdown shown with undo 5 and fake timers); preview y/N defaults to No; Choice picks with ←/→ and Enter; Esc cancels pending and restores text; Ctrl+D with text opens the exit prompt and `x` exits; start: summary printed after exit; command: `it.each` bare/explicit non-TTY behaviour, `isDefault`, settings mapping.
- [ ] **Step 2–4:** red, implement, green; `yarn typecheck && yarn test:run`.
- [ ] **Step 5:** commit `feat(repl): wire threads into the UI with previews, countdowns and key routing`.

### Task 9: Docs and verification

**Files:** `docs/repl.md`, `README.md`, `docs/commands.md`, `docs/configuration.md`, `src/toml-config.ts` (`[repl]` comment for `ask-to-save`).

- [ ] **Step 1:** document modes and prompts, commands, markers and preview, undo/pace and the save offer, thread label, errors and `/retry`, keys table (§10 incl. exit prompt), exit summary, and that bare `bsky` opens the REPL in a terminal. Remove the PR 1 "preview" notes.
- [ ] **Step 2:** `yarn typecheck && yarn test:run && yarn build`; `BSKY_REPL_SMOKE=1 yarn node dist/index.js` (bare) exits 0 with the frame; `yarn node dist/index.js < /dev/null` prints program help and exits 1; PTY matrix (scratchpad `pty_matrix.py`) still 38/38 on Node, Bun runtime and a fresh Bun binary.
- [ ] **Step 3:** commit `docs(repl): document threads, replies and posting`.
