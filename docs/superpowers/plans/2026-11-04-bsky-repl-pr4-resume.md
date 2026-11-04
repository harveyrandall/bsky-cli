# `bsky repl` PR 4 (Resume) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill the terminal mid-thread, run `bsky -r last`, and carry on where you left off (issue #23).

**Architecture:** `core/persist.ts` owns the session file: its shape, `parseSessionFile()` and a store for atomic writes, locks, listing and pruning. `Repl.snapshot()` and `Repl.resume()` turn a session into that shape and back; the store never sees a `Repl`, and the controller never touches the filesystem. A small `LaunchList` runs before the `App`, and `startRepl` wires them together.

**Tech Stack:** as PR 3. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-31-bsky-repl-design.md` §4 (flags), §12, §17 PR 4 row.

## Where this plan departs from the spec

| Spec | This plan | Why |
|---|---|---|
| `mode` holds only reply-once and post-once | Saves every once mode; `target` is the label, resolved through the registry on load | PR 3 added quote, schedule and draft modes. A label that no longer resolves falls back to `returnTo`. |
| `viewed`, `counters.nextViewed` in the file | Saved empty and 0 | `#n` labels arrive in PR 5; keeping the fields means `version: 1` needn't change then. |
| `pending: QueueItem[]` | Saves `Unsent` (with `target`) | A resumed item must go to the same place, and PR 2's items resolve parents at send time. |
| Pending items ask `send · edit · discard` | `edit` puts them in the composer as `asResend` does | Same behaviour as Esc, no second editor path. |

## Global Constraints

- PR 1 to PR 3 Global Constraints hold.
- Files: `bskyDir()/repl/sessions/<id>.json`, mode `0600`, atomic (temp + rename), `version: 1`. Locks: `<id>.lock` holding the PID.
- `<id>` is 6 random base32 characters (`^[a-z2-7]{6}$`).
- Saved after every state change; composer text debounced 1 s. Tokens are never saved.
- Nothing is ever posted on resume without the person choosing `send`.
- Exact copy:
  - list header `Resume a session?`, first row `+ new`, rows `2026-10-31T14:05:22  k3f9xq  @you · 2 threads, 7 posts · "Launch day! Here's what…"`, summary dimmed, local time, newest first, `in use` for a locked session, `unreadable` for a bad file (with delete)
  - replay divider `── resumed k3f9xq ──`, replayed lines dimmed
  - pending prompt `Unsent from last time: "first line…"` with `Send · Edit · Discard`
  - staged file gone `chart.png is no longer there; dropped it`
  - cursor gone `The post you were replying to has gone; continuing from (3)`, or `The thread's posts have gone; thread stopped`
  - summary `7 posts in 2 threads · resume: bsky -r k3f9xq`

## Review Focus

1. A kill during a write leaves the previous file whole; a temp file left behind is ignored and cleaned up. Test: Task 2 "keeps the old file when the write dies".
2. A file that fails any guard is listed as `unreadable` and never loaded half-valid. Test: Task 1 table of corrupted fields.
3. Two REPLs can't share a session, and a dead PID's lock doesn't block forever. Test: Task 2 lock cases.
4. Pending posts never send by themselves on resume, including one that may have been in flight at the kill. Test: Task 4 "asks before sending anything".
5. A session belonging to another account is opened under its own profile, or refused; it never posts as the wrong account. Test: Task 5 account cases.

The session file also closes a gap left by PR 3: when the terminal goes away, queued posts and staged media survive, because they're on disk. Saved `pending` items use `Pipeline.unsent()`, so a post in flight at the kill is saved too and must be offered, not assumed gone. A queued thread item's `target` is the cursor when saved, so items behind one another chain only if they're restored in order and resolve their parent at send time.

---

### Task 1: The file format

**Files:** Create `src/repl/core/persist.ts`, `src/repl/core/persist.test.ts`; Modify `src/repl/core/types.ts` (`IsoUtc`, `SessionId`, `isIsoUtc`, `isSessionId`, `isMarker`).

**Produces:** `interface ReplSessionFile` as spec §12, with the changes above; `parseSessionFile(raw: unknown): ReplSessionFile` (throws, naming the field).

- [ ] Tests: a good file round-trips; a table of one bad field each (`version`, `id`, a post's `uri`, `cid`, `label`, `thread.cursor`, `mode.kind`, `settings.undo`, a marker, `staged[0].kind`, `pending[0].intent`) throws. Fields can be valid alone and wrong together, so also: `staged` that `canStage` wouldn't allow, a pending quote with two posts or with media. Staged paths must be absolute. Red → implement → green → commit `feat(repl): define and validate the session file`.

### Task 2: The store

**Files:** Add to `persist.ts`.

**Produces:** `newSessionId(): SessionId`; `class SessionStore { constructor(dir); save(file); load(id); list(): Promise<SessionListing[]>; delete(id); lock(id): Promise<boolean>; unlock(id); prune(keep: number) }`; `SessionListing = { id; updatedAt; summary; state: "ok" | "in use" | "unreadable" }`; `resolveId(input: string, listings): SessionId` for an id, a unique prefix or `last`.

- [ ] Tests (real temp dir): mode `0600`; **keeps the old file when the write dies**; list is newest first and marks `unreadable`; a live PID's lock refuses, a dead PID's lock is cleared; prune keeps the newest and never removes a locked session; `resolveId` handles `last`, a prefix, an ambiguous prefix (error listing them) and no match. Red → implement → green → commit `feat(repl): store sessions atomically, with locks and pruning`.

### Task 3: Saving

**Modify:** `core/refs.ts` (`Registry.snapshot()`, `Registry.restore()`), `core/repl.ts` (`snapshot()`, `ReplDeps.saveSession?`), `ui/App.tsx`, `ui/Composer.tsx` (`onTextChange`, debounced in the App).

**Produces:** `Repl.snapshot(composer: { text: string; cursor: number }, history: string[]): ReplSessionFile`.

- [ ] Tests: snapshot round-trips through `parseSessionFile`; posting, a mode change, staging and cancelling each save; typing saves once after 1 s of quiet; tokens appear nowhere in the file. Red → implement → green → commit `feat(repl): save the session as it changes`.

### Task 4: Resuming

**Modify:** `core/repl.ts`, `core/refs.ts`, `core/pipeline.ts` (`enqueue` keeps a saved `target`).

**Produces:** `Repl.resume(file: ReplSessionFile): Promise<{ composer: string; history: string[] }>`.

- [ ] Tests: registry labels carry on from where they stopped; the cursor is checked with `getPosts`, falling back to the nearest surviving ancestor, else stopping the thread; a network failure during that check keeps the thread and says so; missing staged files are dropped with the copy above; **asks before sending anything**, with `Send`, `Edit` and `Discard` each doing what they say; a once mode whose label is gone returns to `returnTo`. Red → implement → green → commit `feat(repl): resume a saved session`.

### Task 5: Launch

**Modify:** `src/commands/repl.ts` (`-r`, `--resumable`, `-R`, `keep-sessions`; drop `NOT_YET`), `src/repl/index.tsx`, `core/summary.ts`; Create `src/repl/ui/LaunchList.tsx`.

- [ ] Tests: the list shows only with `resumable` on, at least one session, a TTY and no id; `+ new` is pre-selected; `in use` can't be opened; `unreadable` offers delete; `-r last` and `-r k3f` skip it; `-R` saves nothing and leaves out the resume hint; a session for another account switches to its profile, and is refused if that profile has no login; empty sessions are deleted on exit; prune runs on exit; the lock is released on every exit path. Red → implement → green → commit `feat(repl): list and open saved sessions`.

### Task 6: Docs and verification

- [ ] `docs/repl.md` (resuming, `-r`, `-R`, `keep-sessions`; drop the "later release" notes), `docs/configuration.md`, `generateDefaultConfig()`, README, shell completions.
- [ ] `yarn typecheck && yarn test:run && yarn build`; PTY matrix on Node and Bun; binary smoke.
- [ ] PTY: start offline, write a thread, `SIGKILL`, `-r last`, check the prompt and the replay.
- [ ] Commit `docs(repl): document resumable sessions`.
