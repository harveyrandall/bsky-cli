# Design: `create-thread` Command

## Context

Users write long-form content that exceeds Bluesky's 300-grapheme limit. Currently they must manually split text into posts and self-reply to create threads. This command automates that: split text intelligently at sentence boundaries, preview before posting, handle media/embeds per-post, and integrate with the existing draft system for error recovery.

Branch: `feat/create-thread` (off `main`)

## Command Signature

```
bsky create-thread <text...>
  --stdin                      Read text from stdin
  --draft                      Save as draft instead of publishing
  --thread-label               Add 🧵 1/N label to each post
  --prepend-thread-label       Put label at start (default: append)
  --image <files...>           Images distributed across posts in order
  --image-alt <alts...>        Alt text for images (parallel)
  --video <file>               Video (first post only, unless --media-all)
  --video-alt <alt>            Alt text for video
  --link <urls...>             Link embeds distributed across posts in order
  --media-all                  Attach same media to every post
  --reply-to <uri>             First post replies to this URI
  --quote <uri>                First post quotes this URI
  --no-preview                 Skip interactive preview (default: preview on)
```

## New/Modified Files

| File | Action | Purpose |
|------|--------|---------|
| `src/lib/split-thread.ts` | **New** | Pure text splitting + grapheme utilities |
| `src/lib/split-thread.test.ts` | **New** | Splitting tests |
| `src/commands/create-thread.ts` | **New** | Command, preview, posting orchestration |
| `src/commands/create-thread.test.ts` | **New** | Command tests |
| `src/lib/types.ts` | Modify | Add `"thread"` to Draft type, add `ThreadDraftPost` |
| `src/commands/post.ts` | Modify | `createPost` returns `{ uri, cid }`, export error helpers |
| `src/commands/post.test.ts` | Modify | Update for new return type |
| `src/commands/draft.ts` | Modify | Thread-aware list/show/send/sync |
| `src/commands/draft.test.ts` | Modify | Thread draft tests |
| `src/index.ts` | Modify | Register `registerCreateThread` |

---

## 1. Text Splitting (`src/lib/split-thread.ts`)

### Grapheme counting

Use `Intl.Segmenter` (Node 22+ native) — matches Bluesky's grapheme limit semantics:

```typescript
export function graphemeLength(text: string): number;
```

### Core: `splitThread(text, opts)`

**Boundary priority** (scan backwards from max position):
1. Sentence endings (`. ` `? ` `! ` or end-of-string)
2. Clause boundaries (`, ` `; ` `— ` `: `)
3. Word boundaries (any space)
4. Never split mid-word — error if single word > max

**Label accounting:** Labels like `🧵 3/5` consume graphemes. The splitter:
1. Estimates post count → determines label length
2. Subtracts label + separator from `maxChars` to get effective max
3. Splits greedily
4. Checks last post >= 75 chars; if not, redistributes last two posts
5. If post count changed label digit width, re-runs (converges in 1-2 iterations)

### Edge case detection (301-375 chars)

```typescript
export function isEdgeCaseLength(text: string): boolean;
export function trimSuggestions(text: string, target?: number): string[];
```

`trimSuggestions` finds 2-3 sentence/clause boundaries near the 300 mark and returns human-readable suggestions with exact char counts to remove.

---

## 2. Type Changes (`src/lib/types.ts`)

```typescript
export interface ThreadDraftPost {
  text: string;
  images?: string[];
  imageAlts?: string[];
  video?: string;
  videoAlt?: string;
  link?: string;
}

export interface Draft {
  // ... existing fields ...
  type: "post" | "reply" | "quote" | "thread";   // add "thread"
  posts?: ThreadDraftPost[];                       // new: split posts with per-post media
}
```

`text` stores original unsplit text (for re-editing). `posts` stores split posts with per-post media. Existing draft CRUD needs zero changes — it serialises JSON generically.

---

## 3. `createPost` Return Type (`src/commands/post.ts`)

Currently returns `Promise<string>` (URI only). Threading needs `{ uri, cid }` for reply refs.

**Change:** Return `Promise<{ uri: string; cid: string }>`.

**Callers to update** (6 sites, all extract `.uri`):
- `post.ts` — 3 `executeOrDraft` callbacks
- `draft.ts` — `drafts send` + `syncNetworkDrafts`

Also **export** `isNetworkError` and `isLengthError` for reuse.

---

## 4. Command Flow (`src/commands/create-thread.ts`)

```
1. Collect text (join args or read stdin)
2. graphemeLength(text) <= 300 → delegate to single createPost
3. 301-375 chars → edge case flow (see §4a)
4. splitThread(text, opts) → ThreadPost[]
5. distributeMedia(posts, mediaOpts) → ThreadPostWithMedia[]
6. --draft → save thread draft, exit
7. Preview (default) → render + interactive loop
8. Post thread sequentially, threading reply refs
```

### 4a. Edge case (301-375)

Auto-save as draft. Show trim suggestions. Offer to accept a suggestion:

```
Thread text is 342 characters — too long for one post, too short
to split naturally. Saved as draft: 1741392000000-a7f3

Trim suggestions (need to remove 42 characters):
  1. End after "...end of this sentence." (cuts 42 chars)
  2. End after "...this clause," (cuts 58 chars)

Tip: pipe through `llm` to auto-trim:
  bsky drafts show 1741392 | llm "shorten to under 300 chars" | bsky post
```

- Accept suggestion → post, delete draft on success
- Reject → print draft location (local path) so user knows where to edit

### 4b. Media distribution

- **Default:** Images 1:1 in post order. Links 1:1 in post order. Video → first post.
- **`--media-all`:** Same media broadcast to every post.
- Extra images beyond post count → warning, dropped.
- `--reply-to` → only first post gets reply refs. `--quote` → only first post.

### 4c. Interactive preview

Render numbered posts as markdown with char counts + media info:

```
--- Post 1/3 (287 chars) ---
First part of the thread text here...
  📷 1 image(s): photo.jpg

--- Post 2/3 (295 chars) ---
Second part continues...
  🔗 Link: https://example.com

--- Post 3/3 (156 chars) ---
Final part.
```

**Commands:** `[c]onfirm` | `[e]dit <N>` | `[d]elete <N>` | `[q]uit`

- **Edit:** Opens `$EDITOR` (fallback `vi`) via `spawnSync` on temp file with `stdio: "inherit"`. Read back, update post, re-render.
- **Delete:** Confirm `Delete post 2? [y/N]`, splice, re-render.
- **Quit:** Offer to save as draft.
- Non-TTY / `--no-preview`: skip straight to posting.

### 4d. Thread posting loop

```typescript
for each post i:
  { uri, cid } = await createPost(agent, post.text, {
    reply: i === 0 ? externalReplyRef : parentRef,
    replyRoot: i === 0 ? externalRootRef : rootRef,
    quote: i === 0 ? quoteRef : undefined,
    images, video, link...
  })
  if i === 0 && !rootRef: rootRef = { uri, cid }
  parentRef = { uri, cid }
```

---

## 5. Error Handling

### Partial failure
Post `i` of `n` fails → print URIs of published posts (1..i-1), save remaining (i..n) as thread draft with `replyUri` = last successful URI. Network → `reason: "network"`, other → `reason: "manual"`.

### SIGINT during posting
Save remaining unpublished posts as thread draft (same pattern as `executeOrDraft`).

---

## 6. Draft Command Updates (`src/commands/draft.ts`)

- **`list`:** Thread drafts show `[thread: 5 posts]` tag
- **`show`:** Render each split post numbered with char counts
- **`send`:** Thread-aware posting loop. If `replyUri` set, first post threads off it (for partial resume).
- **`syncNetworkDrafts`:** Handle `type === "thread"` drafts

---

## Commit Plan

All GPG-signed, conventional commits:

1. `feat(thread): add text splitting module` — `split-thread.ts` + tests
2. `feat(thread): extend Draft type for threads` — types.ts
3. `refactor(post): return {uri, cid} from createPost` — post.ts, draft.ts + test updates
4. `feat(thread): add create-thread command` — command + tests + index registration
5. `feat(thread): add thread support to draft commands` — draft.ts/draft.test.ts updates

## Verification

```bash
yarn typecheck
yarn test:run
# Manual:
echo "short text" | bsky create-thread --stdin          # single post fallback
bsky create-thread "350 char text..."                    # edge case → draft + suggestions
bsky create-thread "long text > 600 chars..." --preview  # split → preview → post thread
bsky create-thread "text..." --thread-label              # 🧵 1/N labels
bsky create-thread "text..." --draft                     # saves thread draft
bsky drafts list                                         # shows [thread: N posts]
bsky drafts send <id>                                    # posts thread from draft
```
