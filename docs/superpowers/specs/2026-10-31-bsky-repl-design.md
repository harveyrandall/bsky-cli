# Design: `bsky repl` — interactive REPL with slash commands

- **Status:** Implemented (PRs 1 to 5; see the plans in `docs/superpowers/plans/`)
- **Date:** 2026-10-31
- **Branch:** `bsky-repl-slash-commands-8aa192`
- **Related:** `docs/plans/2026-03-09-create-thread-design.md` (thread splitting, drafts), deferred "remove Bun" spec (see Future work), update-checker spec (separate, next)

## 1. Context and goals

Writing a thread today means one `bsky post` / `bsky reply` invocation per post, copying URIs between them, or writing everything up front for `bsky create-thread`. The REPL makes threading conversational: type a message, it becomes the next post in the thread, and every post echoes a short reference you can reply to, branch from, like, quote or delete without leaving the session.

**Goals**

- Write a thread one message at a time, with numbered posts you can branch from.
- Control splitting precisely with inline markers, with a live per-segment character ring.
- Optional undo window and pacing between posts.
- Media, quotes, scheduled posts and drafts from the same prompt.
- Run any existing `bsky` subcommand inside the REPL, and act on posts it prints by short label.
- Resume a session after exit or crash.

**Non-goals (this version)**

- Model-generated alt text or session summaries (Future work).
- Removing Bun from the release pipeline (separate, deferred spec).
- Quote posts with media (`recordWithMedia`).
- Counted thread labels (`🧵 n/N`) in the REPL: Bluesky now shows a thread's post count natively, so the REPL's optional label is the icon alone (§7).
- A full-screen TUI; the REPL is a scrolling log with a live composer at the bottom.

## 2. Decisions summary

| Topic | Decision |
|---|---|
| UI stack | Ink 8 + React 19 for UI; all logic in a UI-free `core/` |
| Launch | `bsky repl`, and bare `bsky` in a TTY (non-TTY bare `bsky` keeps printing help) |
| Post identifier | `(n) <rkey>`; verbose adds `(at://…)` |
| Numbering | Session-wide by default; `--prefix-thread`/`-l` switches to lettered `(A1)` labels |
| Viewed posts | `#n` labels, session-wide, deduplicated by URI |
| Idle plain text | Hint, text kept; `--auto-thread`/`-t` makes it start a thread |
| Cooldowns | Two settings: undo window and pacing, each none/5/10/15 s; answers can be saved to config (yes / no / no, don't ask again) |
| Thread label | Off by default; when on, each post in the active thread gets a `🧵` icon with no `n/N` count |
| Over-limit text | Always preview; trim hints only for 301–375 auto-split; `[y/N]` always defaults to No |
| Markers | `///` split here · `//>` send up to here, keep the rest · `<//` discard what follows · `\` escapes |
| Newlines | Shift+Enter (kitty keyboard protocol), Alt+Enter, Ctrl+J, trailing `\` |
| Media | `/attach`, drag-and-drop onto an empty composer, `/new` guided flows; image limit read from the lexicon |
| Alt text | Prompt explains why it matters; `--force-alt`/`-f` requires it |
| Existing subcommands | Passthrough by default (`/timeline`), `/run <cmd>` when names collide |
| Resume | On by default; `-r/--resume [id]`, `-R/--no-resumable`; launch list with "+ new" first |
| Stored strings | Template literal and branded types, validated by type guards wherever data enters |
| Bun | Stays for binaries for now; REPL must work on Node and the Bun-compiled binary |

## 3. Architecture

```
src/commands/repl.ts        registerRepl(): Commander wiring, flags, TTY check, lazy import
src/repl/
  index.ts                  startRepl(opts) → render(<App/>)
  core/                     plain TypeScript, no Ink/React; unit-tested
    types.ts                template-literal + branded types (Did, AtUri, Cid, Label…) and type guards
    session.ts              modes, thread {root, cursor, letter}, settings; toJSON/fromJSON
    refs.ts                 labels (n | A2 | #n), parse + resolve refs, registry
    markers.ts              //> <// /// parsing with "\" escapes
    commands.ts             tokenizer, command registry types, help metadata
    dispatch.ts             native → passthrough → unknown (+ suggestion); /run
    passthrough.ts          run a Commander subcommand with exit guard + stdout redirect
    pipeline.ts             queue: undo window, pacing, createPost, errors → drafts
    media.ts                staging, dropped-path detection, size/type/limit checks
    persist.ts              session files: atomic save, load, lock, prune, list
    summary.ts              exit summary (short/verbose), launch-list summary line
  ui/                       Ink components; no business logic
    App.tsx                 header, <Static> log, composer, overlays
    Composer.tsx            multi-line editor, ring, attachment chips
    Ring.tsx, Countdown.tsx, SplitPreview.tsx
    NewMenu.tsx             @inkjs/ui Select
    AltPrompt.tsx, DatePrompt.tsx, SessionPicker.tsx, ExitPrompt.tsx
    keys.ts                 Esc / Ctrl+C / Ctrl+D routing; raw input (paste, kitty)
    terminal.ts             enable/restore bracketed paste + kitty protocol; exit hooks
```

**Changes outside `src/repl/`**

| File | Change |
|---|---|
| `src/index.ts` | `registerRepl(program)` |
| `src/lib/format.ts` | Optional post-labeller hook in `printPost()` (§15); no output change when unset |
| `src/commands/like.ts`, `repost.ts` | Extract `likePost`, `unlikePost`, `repostPost`, `unrepostPost` from inline actions |
| `src/lib/limits.ts` (new) | `maxImages()` read from the `app.bsky.embed.images` lexicon |
| `src/toml-config.ts` | `[repl]` section in `generateDefaultConfig()`; `setConfigValues()` comment-preserving upsert (§4) |
| `src/commands/completions.ts` | `repl` command and flags |
| `tsconfig.json` | `"jsx": "react-jsx"` |
| `vitest.config.ts` | include `src/**/*.test.tsx` |
| `.github/workflows/release.yml` | REPL smoke step for `dist/index.js` and each binary (§16) |
| `package.json` | deps `ink@^8`, `react@^19.3`, `@inkjs/ui@^2`, `@atproto/syntax@^0.5.2` (already installed via `@atproto/api`; made explicit because the guards import it); dev deps `@types/react`, `ink-testing-library@^4` |

**Lazy loading.** The `repl` action does `await import("@/repl")`. tsup splits ESM output into chunks, so React, Ink and yoga only load for the REPL and other commands keep their current startup time.

**One client.** `getClient(program)` runs once at REPL start; the agent is passed to `core/`. `/switch` replaces it.

## 4. Launch, flags and config

`program.command("repl", { isDefault: true })`. Its action:

1. If `BSKY_REPL_SMOKE=1`: render one frame, exit 0 (§16).
2. If stdin or stdout is not a TTY: print help to stderr and exit 1 (today's bare-`bsky` behaviour).
3. Otherwise start the REPL.

`isDefault` is enabled in PR 2 (§17); until then only `bsky repl` opens it.

| Flag | Config (`[repl]`) | Default | Meaning |
|---|---|---|---|
| `-t, --auto-thread` / `--no-auto-thread` | `auto-thread` | `false` | Idle plain text starts a thread |
| `-l, --prefix-thread` | `prefix-thread` | `false` | Lettered labels `(A1)` |
| `--undo <0\|5\|10\|15>` | `undo` | unset → ask | Undo window seconds |
| `--pace <0\|5\|10\|15>` | `pace` | unset → ask | Minimum seconds between posts |
| `-f, --force-alt` | `force-alt` | `false` | Never post media without alt text |
| `--thread-label` | `thread-label` | `false` | Add `🧵` to every post in the active thread |
| `--prepend-thread-label` | `prepend-thread-label` | `false` | Put the icon first instead of last |
| — | `ask-to-save` | `true` | Offer to save undo/pace answers to config |
| `-r, --resume [id]` | — | — | Resume `id` / `last` / unique prefix; list if no id |
| `--resumable` / `-R, --no-resumable` | `resumable` | `true` | Save this session; show the launch list |
| — | `keep-sessions` | `50` | Saved sessions to keep |
| — | `split-marker`, `send-marker`, `cut-marker` | `///`, `//>`, `<//` | Marker strings; must be distinct and non-empty |

The global `-v, --verbose` (and `verbose = true`) applies. Short flags `-t -l -f -r -R` are unused elsewhere; `-p` is avoided because it is `--profile`. Config keys map onto options through the existing `applyConfigToProgram()`.

When `undo` or `pace` is unset, the first thread started in a session — by `/thread`, `/new → Thread` or auto-thread — asks for each (`[none] 5s 10s 15s`) before its first post. Answers become the session values; `/settings` and `/thread --undo N --pace N` change them later.

Unless `ask-to-save = false`, it then offers to keep the answers (only the values it just asked for):

```
Save undo 5s · pace off as your defaults in config.toml?
› Yes    No    No, don't ask again
```

- **Yes:** writes `undo` / `pace` under `[repl]` in the active config file (`-c` › `BSKY_CONFIG` › default path).
- **No:** session only; offered again next session.
- **No, don't ask again:** writes `ask-to-save = false`.

Writes go through `setConfigValues(path, "repl", values)` in `toml-config.ts`, a line-based upsert: inside `[repl]` it replaces an existing `key = …` line or uncomments a `# key = …` line, otherwise inserts after the header; it appends `[repl]` if the section is missing, and creates the file from `generateDefaultConfig()` if there is no file. The result is re-parsed with `smol-toml` before an atomic rename, so a bad write never replaces a good file. A parse-and-stringify round trip is deliberately avoided: it would delete every comment, including the documentation `bsky config init` writes.

## 5. Session model

| Mode | Prompt | Plain text | Entered by | Left by |
|---|---|---|---|---|
| idle | `bsky ›` | Thread if auto-thread, else hint (text kept) | start, stopping a thread | `/thread`, auto-thread |
| thread | `thread (4) ›` / `thread A (A4) ›` | Reply to `cursor`; cursor moves to the new post | `/thread`, `/new → Thread` | Esc/Ctrl+C on empty composer, `/new`, `/switch` |
| reply-once | `reply→2 ›` | Reply to target; cursor unchanged; return to previous mode | `/reply <ref>` (no text) | after one post, or Esc |
| post-once | `post ›` | Standalone post; return to previous mode | `/post` (no text), `/new → Post` | after one post, or Esc |

Thread state is `{ root, cursor, letter? }` (strong refs). `/reply-from <ref>` moves `cursor` (and `root`, if the target is in another thread); it is not a mode.

**`/thread` argument:** none → thread mode, next message is the root. Whole argument parses as a ref → continue that thread (fetch with `getPosts`; `root` = the post's `reply.root`, else the post). Otherwise → text of the first post. `/thread "42"` forces text.

**Registry.** Every post you create, and every external post you target, gets an entry `{ label, uri, cid, rkey, authorDid, parent?, excerpt, external?, deleted? }`. Labels are never reused. An external target takes the next number (or `A0` when it starts a prefixed thread) and prints as `(5) 3lbx… ext @alice.bsky.social`.

**Numbering.**
- Session-wide (default): `(1) (2) (3)…` across all threads and standalone posts.
- Prefixed (`-l`): each thread, and each standalone post, takes the next letter (`A…Z, AA…`); posts are numbered by creation order within it. A bare number resolves within the current thread, or the last one if idle. Fixed for the session.

**Ref resolution** (first match wins):

1. `^\d+$` — own-post label (current/last thread in prefixed mode).
2. `^[A-Za-z]{1,3}\d+$` — prefixed label (upper-cased before lookup); in session-wide mode, an error suggesting `-l`.
3. `^#\d+$` — viewed-post label (§15).
4. `at://…` — handle authority resolved to a DID.
5. `https://bsky.app/profile/<handle|did>/post/<rkey>` — converted to an AT-URI.
6. `^[2-7a-z]{13}$` — bare rkey (TID) in the signed-in account's repo.

Anything else: `Can't resolve "<x>": use a number, #n, rkey, at:// URI or bsky.app link`. Missing CIDs are fetched in one `getPosts` batch.

**Output per post:** `(4) 3lbx7kt5def2v`; verbose `(4) 3lbx7kt5def2v (at://did:plc:…/app.bsky.feed.post/3lbx7kt5def2v)`. Suffixes: `↳ 1` when the parent is not the previous post, `❝ #2` for quotes, `📷 2` / `🎞` for media.

**Deletes** (`/undo`, `/delete <ref>`, own posts only, confirmation required): entry marked `deleted` (struck through in `/history`). If it was the cursor, the cursor moves to its parent. Deleting the root stops the thread (confirmation says so).

**`/switch <profile>`** stops the active thread; the registry is kept.

## 6. Composer

| Key | Action |
|---|---|
| Enter | Submit |
| Shift+Enter, Alt+Enter, Ctrl+J, trailing `\` + Enter | Newline |
| ←/→, ↑/↓ | Move; ↑ on the first line / ↓ on the last steps through this session's sent messages |
| Ctrl+A/E, Alt+←/→ (Alt+B/F), Ctrl+W, Ctrl+U, Backspace, Delete | Line start/end, word jump, delete word, delete to line start |
| Tab | Complete command names → flags → file paths (`/attach`) → recent labels (`/reply`, `/like`, …) |
| Ctrl+G or `/edit` | Edit text in `$EDITOR` (reuses `editPost()`); Ink is suspended meanwhile |

**Terminal modes** (`ui/terminal.ts`), enabled at start and always restored on exit, crash, `SIGTERM`, `SIGHUP`:

- **Bracketed paste** (`ESC[?2004h`): pasted newlines are inserted, never submit; enables drag-and-drop detection.
- **Kitty keyboard protocol** (progressive enhancement, query `ESC[?u`): Shift+Enter arrives as `ESC[13;2u`. If the terminal does not answer the query within ~100 ms, show once: *"This terminal can't tell Shift+Enter from Enter — use Alt+Enter or Ctrl+J for new lines."*

**Ring** (segment-aware). Counts graphemes (`graphemeLength`) of the segment under the cursor — the text between markers, escapes removed:

- Glyph by share of 300: `○` 0–19 %, `◔` 20–49 %, `◑` 50–74 %, `◕` 75–99 %, `●` ≥ 100 %.
- Colour: green < 260, amber 260–300, red > 300 with `342/300 (−42)`.
- Status line: `segment 2/3  ◔ 148/300`. In a `//>`-kept or `<//`-cut region the ring dims and reads `kept` / `cut`.
- With `thread-label` on, posts in the active thread reserve 2 graphemes for the label, so their limit shows as `/298`.

**Attachment chips** above the text: `📎 chart.png · photo.jpg`.

## 7. Markers and submit flow

`markers.ts` parses in this order (markers configurable, §4):

1. Split at the first unescaped `//>`: before → send now; after (including later `//>`) → stays in the composer.
2. In the send part, the first unescaped `<//` discards everything after it.
3. Split the rest at unescaped `///` → posts (trimmed, empty pieces dropped).
4. No `///` and over the limit → `splitThread(text, { splitMarker: false, maxChars })`, where `maxChars` is 300, or 298 for thread posts with `thread-label` on.

A `\` immediately before a marker makes it literal and is removed; other backslashes are untouched. `markers.ts` does its own `///` handling because `splitThread`'s manual mode has no escapes (e.g. `file:///…`).

Result: `{ posts: string[], keep?: string, discard?: string, autoSplit: boolean, markersUsed: boolean }`.

**Submit**

- **Direct:** one post, ≤ 300 graphemes, no markers used → pipeline.
- **Preview** (everything else): full text of every post with counts and media placement; `Kept for next: …`; `Discarded: …` (dimmed); trim hints (`trimSuggestions`) only when `autoSplit` and 301–375 graphemes; then `Post N? [y/N]` (default No regardless of length).
- A marker-made segment over 300 is shown red with no prompt; any key returns to the composer with the cursor in that segment.
- **No / Esc:** text returns exactly as typed.
- **Yes:** posts go to the pipeline as one batch; the composer then holds `keep` (if any). Discarded text is printed once (dimmed) and not stored.

**Thread label** (`thread-label`, off by default). Every post in the active thread — the root, continuations, and `/reply` branches within it — gets `🧵` on its own line, appended, or prepended with `prepend-thread-label`. There is no `n/N` count: Bluesky now shows a thread's post count natively, and a thread written live has no known total anyway. Standalone posts, quotes and replies to other threads are never labelled. The label's 2 graphemes (`\n🧵`) count against the limit, so every "300" in this section reads 298 for labelled posts, and the preview shows posts with their label.

## 8. Media and alt text

- `/attach <path…> [--alt "…"]` validates existence, type (image/video by magic bytes, as `createPost` does) and size, then prompts for alt text per file.
- Limits: images up to `maxImages()` (read at runtime from `lexicons.getDef("app.bsky.embed.images")` — 4 today; rises when `@atproto/api` ships a higher lexicon), or one video; never both.
- Staged media attaches to the **first post** of the next batch; the preview marks it. `/detach [n|all]`.
- **Drag-and-drop:** a bracketed paste into an **empty** composer consisting only of paths to existing media files (quoted, or `\ `-escaped spaces) asks `Attach chart.png? [Y/n]`. Into a non-empty composer it is inserted as text.
- `/new → Image post` / `Video post` run the same prompts, then the composer (post-once mode).

**Alt-text prompt** opens with one sentence: *"Alt text tells people using screen readers what's in your image — without it, they're left out of the post."*

- Default: Enter skips (alt falls back to the file name, current `createPost` behaviour).
- `--force-alt` / `force-alt = true`: re-prompts until non-blank text is given; Esc drops that file instead.
- `TODO(alt-text-ai)` comment at the prompt: future local-model generation (Future work).

## 9. Posting pipeline

`pipeline.ts` is a FIFO queue of items `{ intent, posts[], media?, quote?, createdAt }` where `intent` is `next-in-thread`, `reply-to <ref>`, or `standalone`. Parent/root refs are resolved **at send time**, so a message queued behind a pending one replies to it.

- First post of an item sends at `max(now + undo, lastSentAt + pace)`; shown as one countdown: `Sending in 7s… [Esc] cancel  [Enter] send now`.
- Later posts in a batch send at `lastSentAt + pace`.
- During the undo window the composer shows the pending text dimmed and read-only. Once the window ends (sending, or waiting only on pacing), the composer is free again and Enter queues the next item behind it.
- While items are pending, cursor-changing commands (`/reply-from`, `/thread`, `/new`, `/switch`) are refused: "Wait for pending posts, or Esc to cancel them".
- Each sent post is registered and printed (§5) and the cursor advances (thread intent only).
- Item lifecycle: `queued → counting → pacing → sending → sent | cancelled | failed`.

## 10. Keys

Resolved innermost-first:

| Layer | Esc | Ctrl+C | Ctrl+D |
|---|---|---|---|
| Overlay open (preview, menu, prompt) | Close (preview text → composer) | Same | — |
| Items pending | Cancel them; text → composer if empty, else saved as a draft (id printed) | Same | — |
| reply-once / post-once | Back to previous mode | Same | — |
| Composer has text | — | Clear it | — |
| Thread mode | Stop the thread | Stop the thread | — |
| Idle | — | Hint "Ctrl+D to exit" | — |
| Any | | | Exit; if anything would be lost: `[s]end now · save [d]raft · discard [x] · [Esc] stay` |

Stopping a thread prints `Thread stopped (5 posts, root (1) 3lbx…)`.

## 11. Errors

The REPL never exits on an error.

| Error | Handling |
|---|---|
| Network (`isNetworkError`) | Failed post + rest of its batch saved as a draft (`reason: "network"`, `replyUri` = parent; thread draft if > 1). Existing draft sync sends it next run. `/retry` resends now and deletes the draft on success. Cursor unchanged. |
| Rate limit (429) | Retry once automatically if reset ≤ 60 s; otherwise as network. |
| Rejected upload/record | Show error; text and staged media return to the composer. |
| Expired session | "Session expired — exit and run `bsky login`". |
| Passthrough command | Print error; continue (§14). |
| Unknown command / bad ref | Message with suggestion; text kept. |

## 12. Resumable sessions and exit summary

**Storage:** `bskyDir()/repl/sessions/<id>.json`, mode `0600`, `<id>` a random 6-character base32 string. Written atomically (temp file + rename) after every state change; composer text debounced 1 s.

**Saved state** (types from `core/types.ts`, below)

```ts
interface ReplSessionFile {
  version: 1;
  id: SessionId;
  createdAt: IsoUtc;
  updatedAt: IsoUtc;
  handle: Handle; did: Did; profile?: string;
  settings: {
    autoThread: boolean; prefixThread: boolean;
    threadLabel: false | "append" | "prepend";
    undo: Cooldown; pace: Cooldown; verbose: boolean; forceAlt: boolean;
    markers: { split: Marker; send: Marker; cut: Marker };
  };
  posts: RegistryEntry[];       // own posts + external targets; label: OwnLabel, uri: AtUri, cid: Cid, rkey: Rkey
  viewed: ViewedEntry[];        // label: ViewedLabel, uri: AtUri, cid: Cid
  thread?: { root: StrongRef; cursor: StrongRef; letter?: ThreadLetter };
  mode: ReplMode;
  composer: { text: string; cursor: number };
  staged: { path: string; kind: "image" | "video"; alt?: string }[];
  pending: QueueItem[];
  history: string[];
  counters: { nextLabel: number; nextViewed: number; nextLetter: number };
}

type ReplMode =
  | { kind: "idle" }
  | { kind: "thread" }
  | { kind: "reply-once"; target: Label; returnTo: "idle" | "thread" }
  | { kind: "post-once"; returnTo: "idle" | "thread" };
```

Tokens are not saved; the profile's session file handles auth.

**Types and guards** (`core/types.ts`). Template literal types give stored strings a checked shape at compile time; branded types cover formats a template can't express. Neither exists at runtime — `JSON.parse` returns `any` — so every value entering from outside (session file, config, user input, API response) goes through a guard, and `as` casts to these types are only allowed inside the guards.

```ts
type Did = `did:plc:${string}` | `did:web:${string}`;
type Handle = `${string}.${string}`;
type AtUri = `at://${Did}/app.bsky.feed.post/${string}`;
type Cid = `b${string}`;                                     // CIDv1, base32 multibase prefix
type IsoUtc = `${number}-${number}-${number}T${number}:${number}:${number}${"" | `.${number}`}Z`;
type ThreadLetter = Uppercase<string>;                       // "A" … "ZZZ" (a whole string)
type Upper = Uppercase<string>;                              // one character per placeholder below
type OwnLabel =                                              // "4", "A4", "AA4", "ZZZ999"
  | `${number}` | `${Upper}${number}` | `${Upper}${Upper}${number}` | `${Upper}${Upper}${Upper}${number}`;
// Adjacent placeholders each match one character except the last, so
// `${Upper}${number}` alone would reject "AA3" ("A" + "A3"). Verified with tsc.
type ViewedLabel = `#${number}`;                             // "#12"
type Label = OwnLabel | ViewedLabel;
type Cooldown = 0 | 5 | 10 | 15;
type SessionId = string & { readonly __brand: "SessionId" }; // 6 base32 chars
type Rkey = string & { readonly __brand: "Rkey" };           // a TID
type Marker = string & { readonly __brand: "Marker" };       // non-empty, no whitespace
interface StrongRef { uri: AtUri; cid: Cid }
```

| Guard | Checks |
|---|---|
| `isDid`, `isHandle`, `isRkey` | `isValidDid`, `isValidHandle`, `isValidTid` from `@atproto/syntax` |
| `isAtUri` | Parses with `AtUri`: DID authority, collection `app.bsky.feed.post`, valid rkey |
| `isCid` | `b` prefix followed by base32 (`[a-z2-7]+`) |
| `isIsoUtc` | `isDatetimeString` from `@atproto/syntax` and a trailing `Z` |
| `isOwnLabel`, `isViewedLabel`, `isLabel` | `^\d+$` or `^[A-Z]{1,3}\d+$` / `^#\d+$` / either |
| `isCooldown`, `isSessionId`, `isMarker` | Member of `{0,5,10,15}` / `^[a-z2-7]{6}$` / non-empty, no whitespace |

- `toStrongRef(res)` turns `createPost`'s `{ uri: string; cid: string }` into a `StrongRef`, or throws.
- `parseSessionFile(raw: unknown): ReplSessionFile` checks `version` and every field with the guards. A file that fails is listed as `unreadable` in the launch list (with an option to delete it) and is never loaded half-valid.
- Config values (`undo`, `pace`, markers) are guarded at REPL start; an invalid one stops with an error naming the key and value.

**Launch list** — shown when `resumable` is on, at least one saved session exists, stdin is a TTY and no `--resume <id>` is given:

```
Resume a session?
› + new
  2026-10-31T14:05:22  k3f7xq  @you · 2 threads, 7 posts · "Launch day! Here's what…"
  2026-10-30T21:40:03  p2m2wd  @you · 1 thread, 3 posts · "Thinking about lexicons…"
```

Newest first, local time as `YYYY-MM-DDTHH:MM:SS`, summary dimmed (built from counts + first post text). `+ new` is pre-selected. Sessions locked by a running REPL show `in use` and cannot be opened.

**On resume:** replay registry lines dimmed under `── resumed k3f7xq ──`; verify `cursor` with `getPosts` (if deleted, fall back to the nearest surviving ancestor, else stop the thread); pending items ask `send · edit · discard`; missing staged files are dropped with a warning; if the session's account differs, switch to its profile.

**Housekeeping:** lock file `<id>.lock` with the PID (stale locks with dead PIDs are cleared); sessions with no posts and no composer text are deleted on exit; prune to `keep-sessions`, oldest first.

**Exit summary**

- Normal: `7 posts in 2 threads · resume: bsky -r k3f7xq` (resume hint omitted with `-R`).
- Verbose: session id, start–end time and duration, handle; per thread, every post as `(n) rkey (at://…) "excerpt"`; standalone posts; deleted posts; failures with draft ids; resume command.

## 13. Slash commands

`<ref>` = number, label, `#n`, rkey, at:// URI or bsky.app link.

| Group | Command | Does |
|---|---|---|
| Write | `/thread [text\|ref] [-v] [--undo N] [--pace N]` | Start / continue a thread, or enter thread mode |
| | `/reply <ref> [text]` | Reply once (no text → reply-once mode) |
| | `/reply-from <ref>` | Move the thread cursor |
| | `/post [text]` | Standalone post (no text → post-once mode) |
| | `/quote <ref> [text]` | Quote post (no media) |
| | `/new` | Stop the thread; menu: Post · Thread · Image post · Video post · Quote post · Scheduled post · Draft |
| | `/attach <path…> [--alt "…"]`, `/detach [n\|all]` | Stage / unstage media |
| | `/edit` (Ctrl+G), `/retry` | `$EDITOR`; resend last failed batch |
| Manage | `/undo`, `/delete <ref>` | Delete last / any own post (confirm) |
| | `/drafts` | List drafts; load one into the composer (thread drafts joined with `///`); deleted only after a successful send |
| | `/switch <profile>`, `/history` | Change account; list session posts |
| Engage | `/like <ref>`, `/unlike <ref>`, `/repost <ref>`, `/unrepost <ref>` | Using extracted `like.ts` / `repost.ts` functions; un-actions use `viewer.like` / `viewer.repost` |
| | `/open <ref>`, `/view <ref>`, `/copy <ref>` | Browser (`open`/`xdg-open`/`start`); print thread via `printPost`; clipboard (`pbcopy`/`wl-copy`/`xclip`/`clip`) |
| Session | `/auto-thread [on\|off]`, `/settings [undo\|pace N]` | Toggle; settings menu with no args |
| | `/help [cmd]`, `/exit` (`/quit`), `/run <cmd> [args]` | Help; exit (= Ctrl+D); explicit passthrough |

**`/new` items:** Post → post-once; Thread → `/thread`; Image/Video post → `/attach` prompts then post-once; Quote post → ref prompt then composer; Scheduled post → composer, then an Ink date/time prompt built on `parseDate`/`parseTime`/`resolveAmPm`/`toUtcIso`, saved to the existing schedule store; Draft → composer then `saveDraft()`.

## 14. Dispatcher and passthrough

**Dispatcher**

1. Input is a command only if it matches `^/[a-z]` (markers never match; a leading `\/` posts a literal `/`).
2. Shell-style tokenizer (quotes, backslash escapes).
3. Native command → Commander subcommand (passthrough) → `Unknown /usr. Did you mean /undo?` (edit distance over both sets). `/run` skips native lookup.
4. `/help` and Tab completion come from one registry; passthrough entries marked `↗`.

Name collisions that `/run` resolves: `thread`, `reply`, `post`, `quote`, `like`, `unlike`, `repost`, `delete`, `drafts`.

**Passthrough wrapper** (`passthrough.ts`)

- Runs with the REPL's current profile. Arguments that are entirely a `#n` label are expanded to AT-URIs; own-post labels are not, because bare numbers in passthrough arguments are usually counts (`-n 5`) — use native commands or a URI for own posts.
- `exitOverride()` for Commander errors; `process.exit` temporarily replaced with a throwing stub.
- `process.stdout.write` / `process.stderr.write` redirected to Ink's `useStdout().write()` / `useStderr().write()` for the duration (Ink's `patchConsole` covers only `console.*`, but `printPost` writes with `process.stdout.write`).
- Blocked with a hint: `repl`, `login`, `stream`, `create-thread`, `config edit`, and any command found by auditing `createInterface` / `setRawMode` / `promptDateTime` use (plan task).
- Commander option state must not leak between invocations (Commander ≥ 13 restores state between `parse()` calls; covered by a test).

## 15. Viewed-post labels (`#n`)

- `format.ts` gains `setPostLabeler(fn?: (post: PostView) => string | undefined)`. When set, `printPost` prefixes the author line with the label; when unset, output is byte-for-byte unchanged.
- The REPL sets it for its lifetime: posts already in the own-post registry get their `(n)` label; others get `#n` (session-wide, deduplicated by URI, `uri` + `cid` stored, saved for resume).
- Covers every `printPost` caller: `timeline`, `thread`, `search`, `bookmarks` (passthrough) and `/view`.

```
#1 alice.bsky.social [Alice] (2026-10-31T09:12:44.000Z)
Lexicons are the API contract — read them.
 👍(12)⚡(3)↩️ (2)
 - at://did:plc:…/app.bsky.feed.post/3lbw…
```

## 16. Testing and verification

**Unit (Vitest, `core/`, mock agent per `src/test-utils.ts`)**

- `markers`: order, escapes, `file:///`, multiple `//>`, empty segments, over-limit segment flag, custom markers.
- `refs`: every ref form, both numbering modes, `#n`, handle → DID, errors.
- `session`: transitions, cursor after delete, root delete, once-modes return, `/switch`.
- `pipeline` (fake timers): `max(undo, pace)`, cancel, send now, batch pacing, send-time parent resolution, network → draft, `/retry`, 429 retry.
- `dispatch` / tokenizer: precedence, `/run`, `^/[a-z]`, `\/`, suggestions, `#n` expansion.
- `passthrough`: exit guard, stdout redirect, two consecutive parses do not leak `--json`.
- `persist`: round trip, `version`, atomic write, lock + stale lock, prune, `last` / prefix resolution.
- `printPost`: snapshot unchanged without a labeller; label with one.
- `limits`: `maxImages()` equals the lexicon value.
- `types`: accept/reject tables for every guard; `toStrongRef` throws on malformed responses; `parseSessionFile` rejects a wrong `version` and each corrupted field in turn.
- `toml-config` `setConfigValues`: replaces a value, uncomments `# key = …`, inserts into an existing `[repl]`, appends a missing `[repl]`, creates the file from `generateDefaultConfig()`, leaves comments and other sections byte-for-byte intact, and refuses to write output that doesn't re-parse.
- Thread label: 2-grapheme reservation in the ring and auto-split; only active-thread posts labelled; prepend option.

**UI (`ink-testing-library`)**

- Composer: Enter vs Shift+Enter (`ESC[13;2u`), Alt+Enter, Ctrl+J, trailing `\`; bracketed paste with newlines; drag-and-drop prompt.
- Ring glyph/colour thresholds.
- Every row of the key table (§10).
- Preview default N; trim hints only 301–375 auto-split.
- Launch list with `+ new` pre-selected; `--force-alt` loop and Esc-drops-file.
- Undo/pace prompts followed by the save offer; each of its three answers; no offer when `ask-to-save = false` or both values are configured.

**Smoke.** `BSKY_REPL_SMOKE=1 bsky repl` renders one frame and exits 0. Added to the release workflow for `node dist/index.js` and each Bun-compiled binary, proving the lazy chunk, Ink and yoga's WASM (top-level await) load under both runtimes.

**Manual matrix before release:** macOS Terminal.app (no kitty protocol), iTerm2 or Ghostty, VS Code terminal, a Linux terminal, Windows Terminal — each on Node and the Bun binary: keys, paste, drag-and-drop, resize, exit restores the terminal.

## 17. Delivery plan

One spec, five PRs; each is shippable because `repl` is additive.

| PR | Scope | Done when |
|---|---|---|
| 1. Foundations | Deps, tsconfig/Vitest, `repl` command + flags + `[repl]` config, lazy import, App shell, terminal modes, composer (keys, paste, kitty, ring), tokenizer + dispatcher, `/help` `/exit`, smoke step | REPL opens and exits cleanly on Node and the Bun binary |
| 2. Threading | `core/types.ts` + guards, session, refs, markers, pipeline, `/thread` `/reply` `/reply-from` `/post` `/auto-thread` `/settings` `/history` `/retry`, undo/pace save offer + `setConfigValues()`, thread label, preview, key routing, errors, exit summary (normal + verbose), `isDefault` | A full thread can be written end to end |
| 3. Media and `/new` | `/attach` `/detach`, drag-and-drop, alt prompt + `--force-alt`, `maxImages()`, `/new` (7 items), `/quote`, `/edit` | Image, video, quote, scheduled and draft flows work |
| 4. Resume | `persist.ts`, `parseSessionFile()` validation (unreadable files listed, never half-loaded), launch list, lock, prune, `-r` / `-R`, resume hint in exit summary | Kill the terminal mid-thread, `bsky -r last`, continue |
| 5. Commands and passthrough | passthrough wrapper + stdin audit, `/run`, `#n` labeller, like/unlike/repost/unrepost extraction, `/open` `/view` `/copy` `/undo` `/delete` `/drafts` `/switch` | Read the timeline and act on `#n` without leaving the REPL |

**Docs, per PR:** `docs/repl.md` (+ mkdocs nav), README section, `[repl]` in `docs/configuration.md` and `generateDefaultConfig()`, shell completions.

## 18. Risks

| Risk | Mitigation |
|---|---|
| Ink 8's input parser swallows bracketed-paste or kitty sequences | PR 1 spike; fall back to reading raw stdin via `useStdin()` |
| Bun runtime differs on raw mode / TTY | Smoke step on binaries + manual matrix |
| yoga-layout's top-level await in bundled binaries | Smoke step; ESM-only bundle already in place |
| Passthrough commands writing directly to stdout | Redirect in wrapper; audit for interactive commands |
| Commander state leaking between parses | Test; reset option values manually if needed |
| Terminal left in paste/kitty mode after a crash | `terminal.ts` restores on exit, signals and uncaught errors |

## 19. Future work

1. **Remove Bun from the release pipeline** — separate, deferred spec: Node SEA (`node --build-sea`, ESM main) vs dropping binaries; decides the update checker's direct-download channel.
2. **Local-model alt text** (`TODO(alt-text-ai)`) — e.g. Ollama vision model suggests alt text, user confirms or edits.
3. **Model-generated session summaries** for the launch list.
4. **`--force-alt` for `post` and `create-thread`.**
5. **Quote posts with media** (`app.bsky.embed.recordWithMedia`).
6. **Update checker** — npm / Homebrew / direct download, check on use with a 1-day cooldown; brainstormed as its own spec next.
