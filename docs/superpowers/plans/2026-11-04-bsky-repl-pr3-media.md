# `bsky repl` PR 3 (Media and `/new`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Image, video, quote, scheduled and draft posts can all be made from the REPL: `/attach`, `/detach`, drag-and-drop, alt-text prompts with `--force-alt`, `/quote`, `/new`, and `/edit` / Ctrl+G (issue #22).

**Architecture:** Media rules live in UI-free `core/media.ts` and the controller; limits come from the `@atproto/api` lexicons through `src/lib/limits.ts`. The controller stages media and attaches it to the first post of the next batch, and asks for alt text, paths, refs, menu picks and dates through new `ReplAsk` callbacks. The UI adds a text prompt, a date/time prompt, attachment chips, drag-and-drop detection and `$EDITOR` via Ink's `suspendTerminal`.

**Tech Stack:** as PR 2. No new dependencies (the `/new` menu reuses PR 2's `Choice`).

**Spec:** `docs/superpowers/specs/2026-10-31-bsky-repl-design.md` §6 (chips, Ctrl+G), §8, §11 (rejected upload), §13 (`/quote`, `/new`, `/attach`, `/detach`, `/edit`), §17 PR 3 row.

## Where this plan departs from the spec

| Spec | This plan | Why |
|---|---|---|
| `NewMenu.tsx` with `@inkjs/ui` Select | PR 2's `Choice` | Seven short items fit one line; no new dependency. |
| `ui/AltPrompt.tsx`, `ui/DatePrompt.tsx` | One `TextPrompt` in `Overlays.tsx`; the alt and date flows are controller logic | Same behaviour, less UI code. |

## Global Constraints

- PR 1 and PR 2 Global Constraints hold.
- Limits are read from the lexicons, never hard-coded: `app.bsky.embed.images` `images.maxLength` (4), `app.bsky.embed.images#image` `image.maxSize` (1,000,000 bytes), `app.bsky.embed.video` `video.maxSize` (100,000,000 bytes).
- Media types by magic bytes (the existing `detectMimeType`, moved to `src/lib/media.ts`): images png/jpeg/gif/webp, video mp4. Up to `maxImages()` images or one video, never both.
- Exact copy:
  - alt prompt intro `Alt text tells people using screen readers what's in your image — without it, they're left out of the post.` then `Alt text for chart.png (Enter to skip):`; with `--force-alt` `Alt text for chart.png (required; Esc drops the file):`
  - chips `📎 chart.png · photo.jpg` above the composer
  - drop prompt `Attach chart.png? [Y/n]` (several files: `Attach chart.png and 2 more? [Y/n]`)
  - `/new` menu `Post · Thread · Image post · Video post · Quote post · Scheduled post · Draft`
  - prompts `quote→2 ›`, `scheduled ›`, `draft ›`
  - date `Date (DD-MM or DD-MM-YYYY):`, time `Time (HH:MM):`, `AM or PM?` (Choice), `Scheduled for <local time> (<id>)`
  - limit errors `Only 4 images per post`, `A post can have images or one video, not both`, `<file> is over the 1 MB image limit`, `<file> isn't an image or MP4 video`
- `TODO(alt-text-ai)` comment at the alt prompt.

## Review Focus

1. Staged media is never silently lost: a rejected post puts its text and media back; a network failure saves the media in the draft. Test: Task 3 "returns media with the text" and "keeps media in the draft".
2. `--force-alt` re-asks on blank alt text and Esc drops only that file. Test: Task 3 `force-alt` cases.
3. A paste of media paths into an empty composer asks to attach; into a non-empty composer, or when any path isn't media, it is inserted as text. Test: Task 2 `parseDroppedPaths` + Task 6 App paste tests.
4. `/edit` and Ctrl+G give the terminal back to `$EDITOR` and restore the REPL's terminal modes afterwards. Test: Task 6 (suspend called around the editor) + PTY matrix.
5. The image limit follows the lexicon. Test: Task 1 `maxImages()` equals the lexicon value.

---

### Task 1: Shared helpers

**Files:** Create `src/lib/limits.ts`, `src/lib/media.ts`, `src/lib/editor.ts`; Modify `src/commands/post.ts` (import `detectMimeType`), `src/commands/create-thread.ts` (use `editInEditor`); Tests `src/lib/limits.test.ts`, `src/lib/media.test.ts`.

**Produces:** `maxImages(): number`, `maxImageBytes(): number`, `maxVideoBytes(): number`; `detectMimeType(data: Uint8Array): string`; `editInEditor(text: string): Promise<string>` (`$EDITOR` or `vi`, temp file, trimEnd).

- [ ] Tests: limits equal `lexicons.getDef(...)` values; `detectMimeType` table (png, jpeg, gif, webp, mp4, other). Red → implement → green → commit `refactor: share media type detection, lexicon limits and the editor helper`.

### Task 2: `core/media.ts`

**Produces:**

```ts
export interface StagedMedia { path: string; kind: "image" | "video"; alt?: string }
export interface MediaFs { size(path: string): Promise<number | undefined>; head(path: string): Promise<Uint8Array> }
export async function inspectMedia(path: string, fs: MediaFs): Promise<{ kind: "image" | "video" } | { error: string }>;
export function canStage(staged: readonly StagedMedia[], kind: "image" | "video"): string | undefined;
export function parseDroppedPaths(text: string): string[] | undefined; // quoted or `\ `-escaped paths, one per token; undefined if empty or any token isn't a path-like string
export function chips(staged: readonly StagedMedia[]): string;          // `📎 chart.png · photo.jpg`
```

- [ ] Tests: missing file, over-size image/video (limits from Task 1), wrong type, the "not both" and max-images rules, dropped-path parsing (`'/a b.png'`, `/a\ b.png /c.jpg`, plain text → undefined), chips. Red → implement → green → commit `feat(repl): check and stage media files`.

### Task 3: Media in the controller and pipeline

**Modify:** `core/repl.ts`, `core/pipeline.ts`, `src/commands/repl.ts` (agent adapter passes media to `createPost`; `-f` no longer "not used yet"), tests.

**Produces:** `ReplAsk.alt(file: string, required: boolean): Promise<string | undefined | null>` (`undefined` = skipped, `null` = Esc); `Repl.attach(paths: string[], alt?: string): Promise<void>`, `Repl.detach(which?: number | "all"): void`, `Repl.staged(): readonly StagedMedia[]`; `ReplSettings.forceAlt: boolean`; `QueueItem.media?: StagedMedia[]` (first post only); `ReplAgent.post(text, reply?, media?)`; `PipelineDeps.send(text, reply?, media?)`.

- [ ] Tests: attach asks alt per file (the intro line printed once per attach); `--alt` applies to every file and skips the prompt; force-alt re-asks on blank and Esc drops just that file; staged media goes on the first post of the next batch only and is then cleared; preview receives media; **returns media with the text** on a rejected post; **keeps media in the draft** on a network failure; `/detach 1` and `all`. Red → implement → green → commit `feat(repl): attach media to the next post, with alt text`.

### Task 4: Quote, schedule, draft and `/new` in the controller

**Produces:** `ReplMode` gains `{ kind: "quote-once"; target: ResolvedRef; label: string; returnTo }`, `{ kind: "schedule-once"; returnTo }`, `{ kind: "draft-once"; returnTo }`; `ReplAsk.choose(label: string, options: readonly string[]): Promise<number | undefined>`, `ReplAsk.text(label: string): Promise<string | undefined>`, `ReplAsk.dateTime(): Promise<string | undefined>` (ISO UTC, future); `Repl.quote(ref, text?)`, `Repl.newMenu()`, `Repl.dateTime()` helper built on `parseDate`/`parseTime`/`resolveAmPm`/`toUtcIso` (re-asks on invalid input with the CLI's messages); `ReplDeps.saveScheduled(p: Omit<ScheduledPost, "id" | "createdAt">): Promise<{ id: string }>`; `Intent` gains `{ kind: "quote"; target: StrongRef }`.

- [ ] Tests: `/quote 2 hi` posts with `quote` and no media (staged media stays staged, with a note); quote-once mode; `/new` stops a thread, then each menu item enters the right mode (Image/Video ask for a path then attach); scheduled-once saves `{ scheduledAt, text, images/imageAlts|video/videoAlt }` and prints the copy; draft-once saves a manual draft; date flow re-asks on bad input and in the past. Red → implement → green → commit `feat(repl): add /quote, /new, scheduled posts and drafts`.

### Task 5: Commands

**Produces:** `/attach <path…> [--alt "…"]` (raw; paths tokenised shell-style), `/detach [n|all]`, `/quote <ref> [text]` (raw), `/new`, `/edit` (opens `$EDITOR` on an empty draft or the kept text, result into the composer via `CommandContext.edit(text): Promise<string>`).

- [ ] Tests through `dispatch` with a fake `Repl` and `edit`. Red → implement → green → commit `feat(repl): add /attach, /detach, /quote, /new and /edit`.

### Task 6: UI

**Modify:** `ui/App.tsx` (asks: alt, choose, text, dateTime; drop confirm; `edit` via `useApp().suspendTerminal`), `ui/Composer.tsx` (chips line; Ctrl+G → `onEdit(text)`; `onPaste(text): boolean` lets the App take a paste), `ui/keys.ts` (Ctrl+G → `{ type: "edit" }`), `ui/Overlays.tsx` (`TextPrompt`: single line, Enter submits, Esc → undefined), tests.

- [ ] Tests: alt prompt flow through keystrokes; chips render; drop of an existing image path into an empty composer asks `Attach … [Y/n]` and attaches on Enter; the same paste into a non-empty composer is text; Ctrl+G calls the editor with the composer text and puts the result back (suspend mocked); `/new` menu → Draft → text → Enter saves. Red → implement → green → commit `feat(repl): media prompts, chips, drag-and-drop and $EDITOR in the UI`.

### Task 7: Docs and verification

- [ ] `docs/repl.md` (media, alt text, `/new`, `/quote`, scheduled posts, drafts, `/edit`, Ctrl+G; `-f` now works), README, commands page.
- [ ] `yarn typecheck && yarn test:run && yarn build`; PTY matrix (offline chunk) on Node and Bun still passes; binary smoke.
- [ ] Commit `docs(repl): document media, quotes, /new and /edit`.
