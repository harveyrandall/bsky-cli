# `bsky repl` PR 5 (Commands and passthrough) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read the timeline and like, reply to or quote `#n` posts without leaving the REPL (issue #24).

**Architecture:** `core/passthrough.ts` runs any non-interactive CLI command inside the REPL by re-entering Commander with its output routed through Ink. `printPost` gains an optional labeller, so every post the CLI prints gets a `#n` the session can refer to. Native commands (`/like`, `/undo`, `/drafts` and so on) use functions extracted from the CLI commands, reached through `ReplAgent`, so the controller stays UI-free and network-free.

**Tech Stack:** as PR 4. No new dependencies; `/open` and `/copy` use the platform's own programs.

**Spec:** `docs/superpowers/specs/2026-10-31-bsky-repl-design.md` §6 (Tab row), §13, §14, §15, §17 PR 5 row.

## Where this plan departs from the spec

| Spec | This plan | Why |
|---|---|---|
| Passthrough output via `useStdout().write()` | Through the REPL's `print`, a line at a time | `print` is held while `$EDITOR` has the terminal and goes through `<Static>`, so it can't be dropped or tear the frame. |
| §6 Tab: names, flags, paths, labels | Adds flags, `/attach` paths and recent labels here | Left out of PRs 1 to 3. |

## Global Constraints

- PR 1 to PR 4 Global Constraints hold.
- Resolution order: native command → Commander subcommand (passthrough) → `Unknown /usr. Did you mean /undo?` (edit distance over both sets). `/run` skips the native lookup. `/help` and Tab read one registry; passthrough entries are marked `↗`.
- Blocked with a hint: `repl`, `login`, `stream`, `create-thread`, `config edit`, and whatever the Task 1 audit finds.
- `#n` labels are session-wide, deduplicated by URI, with `uri` and `cid` stored and saved with the session. With no labeller set, `printPost` output is byte-for-byte unchanged.
- In passthrough arguments only an argument that is entirely a `#n` is expanded; a bare number is left alone, as it's usually a count (`-n 5`).
- `/delete` and `/undo` confirm first, and only ever act on your own posts.
- Exact copy:
  - `/undo` prompt `Delete (4) "first line…"? [y/N]`, then `Deleted (4)`
  - `/switch` `Now posting as @work.bsky.social`
  - blocked `bsky login can't run inside the REPL: run it in another terminal`
  - `/copy` `Copied (4)`; no clipboard tool `Couldn't find a clipboard tool (tried pbcopy, wl-copy, xclip, clip)`

## Review Focus

1. A failing passthrough command never ends the REPL, and `process.exit` and the output streams are always put back. Test: Task 1 "survives a command that exits" and "restores on a throw".
2. Commander state doesn't leak between runs: `/timeline --json` then `/timeline` prints text. Test: Task 1 "doesn't keep options between runs".
3. `/delete` and `/undo` can't delete someone else's post, and refuse a post that's queued or was deleted already. Test: Task 5.
4. `/switch` can't leave queued posts or a thread pointing at the old account. Test: Task 5.
5. `#n` survives a resume, and new labels carry on from the saved count. Test: Task 2 "keeps #n across a resume".

---

### Task 1: Passthrough

**Files:** Create `src/repl/core/passthrough.ts`, `src/repl/core/passthrough.test.ts`; Modify `core/commands.ts`, `core/dispatch.ts`, `src/commands/repl.ts`.

**Produces:** `runPassthrough(program: Command, argv: string[], io: { print(text: string): void }): Promise<void>`; `CommandContext.passthrough(argv: string[]): Promise<void>`; `BLOCKED: Map<string, string>`; `/run <cmd> [args]`.

- [ ] Audit: every use of `createInterface`, `setRawMode`, `promptDateTime` and `stdin` under `src/commands/`, recorded in `BLOCKED` with a reason.
- [ ] Tests: **survives a command that exits** (a throwing `process.exit` stub, restored after); **restores on a throw**; output arrives through `io.print`, split on lines; **doesn't keep options between runs**; a blocked command prints its hint; the current profile is used; unknown names suggest across both sets. Red → implement → green → commit `feat(repl): run CLI commands from the REPL`.

### Task 2: `#n` labels

**Modify:** `src/lib/format.ts` (`setPostLabeler`), `core/refs.ts` (`ViewedLabel`, `addViewed`, `resolveRef` for `#n`), `core/persist.ts` (`viewed`, `nextViewed`), `core/repl.ts`, `core/passthrough.ts`.

- [ ] Tests: output unchanged with no labeller; own posts show `(n)`, others `#n`; the same URI keeps its label; `/reply #2 hi`, `/quote #2 hi` and `/like #2` resolve; `#n` expands in passthrough only as a whole argument; **keeps #n across a resume**. Red → implement → green → commit `feat(repl): label posts you read, so you can act on them`.

### Task 3: Likes and reposts

**Files:** Modify `src/commands/like.ts`, `src/commands/repost.ts` (extract `likePost`, `unlikePost`, `repostPost`, `unrepostPost`), `core/repl.ts` (`ReplAgent`), `core/commands.ts`, `src/commands/repl.ts`.

- [ ] Tests: the CLI commands behave as before; `/like`, `/unlike`, `/repost`, `/unrepost` work on `(n)` and `#n`; the un-actions use `viewer.like` and `viewer.repost`, and say so if there's nothing to undo. Red → implement → green → commit `feat(repl): add /like, /unlike, /repost and /unrepost`.

### Task 4: `/open`, `/view`, `/copy`

**Produces:** `postUrl(entry)`; `openUrl`, `copyText` injected as `ReplDeps`; `/view` prints the thread through `printPost`.

- [ ] Tests: the right program per platform; a missing clipboard tool says so; `/view #2` labels what it prints; a failed `/open` keeps the REPL running. Red → implement → green → commit `feat(repl): add /open, /view and /copy`.

### Task 5: `/undo`, `/delete`, `/drafts`, `/switch`

**Produces:** `Repl.deletePost(ref)`, `Repl.undo()`, `Repl.drafts()`, `Repl.switchProfile(name)`; `ReplAgent.deletePost(uri)`; `Registry.markDeleted`; `ReplDeps.listDrafts`, `switchAgent`.

- [ ] Tests: confirm first, default No; someone else's post is refused; a deleted post is marked, shown in the summary, and the cursor falls back as on resume; `/drafts` lists, loads one into the composer (threads joined with the split marker) and deletes it only after a successful send; `/switch` refuses while posts are queued, stops the thread and clears staged media with a warning. Red → implement → green → commit `feat(repl): add /undo, /delete, /drafts and /switch`.

### Task 6: Tab completion

**Modify:** `core/commands.ts`, `ui/Composer.tsx`.

- [ ] Tests: flags after a command; `/attach` paths, with `~/` and escaped spaces; recent labels after `/reply`, `/like` and the like; passthrough names. Red → implement → green → commit `feat(repl): complete flags, paths and labels with Tab`.

### Task 7: Docs and verification

- [ ] `docs/repl.md`, `docs/commands.md`, README, spec status.
- [ ] `yarn typecheck && yarn test:run && yarn build`; PTY matrix on Node and Bun; binary smoke.
- [ ] PTY: run a passthrough command with a fake agent, check the output arrives whole and the composer still works.
- [ ] Commit `docs(repl): document commands and passthrough`.
