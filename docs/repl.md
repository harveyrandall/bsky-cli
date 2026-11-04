# REPL

`bsky repl` opens an interactive composer for writing posts and threads. In a terminal, plain `bsky` with no command opens it too.

```bash
bsky repl
bsky          # same, in a terminal
```

The REPL needs an interactive terminal. If stdin or stdout isn't a terminal (for example `bsky repl | tee log`), it says so, prints its help to stderr and exits with status 1. Plain `bsky` without a terminal prints the CLI's help, as it always has.

## Writing

The prompt shows what Enter will do with plain text:

| Prompt | Mode | Plain text |
|---|---|---|
| `bsky ›` | idle | A hint, text kept — or a new thread with `-t` / `/auto-thread on` |
| `thread ›`, `thread (4) ›` | thread | The next post, replying to the post in brackets |
| `thread A (A4) ›` | thread, with `-l` | The same, with lettered labels |
| `reply→2 ›` | reply once | A reply to post 2, then back to the previous mode |
| `post ›` | post once | A post on its own, then back |
| `quote→2 ›` | quote once | A post quoting post 2, then back |
| `scheduled ›` | scheduled | Asks when, saves a scheduled post, then back |
| `draft ›` | draft | Saves a draft, then back |

| Command | Does |
|---|---|
| `/thread [text\|ref]` | Start a thread (its first post, if you give text), or continue from the post a ref names. `/thread "42"` posts the text `42`. `--undo N` and `--pace N` go first and change the session's setting. |
| `/reply <ref> [text]` | Reply once — now with text, or to whatever you type next |
| `/reply-from <ref>` | Continue the thread from another post |
| `/post [text]` | Post on its own |
| `/quote <ref> [text]` | Quote a post — now with text, or whatever you type next. A quote is one post, and can't have media |
| `/new` | Pick what to write next: `Post · Thread · Image post · Video post · Quote post · Scheduled post · Draft`. Picking one stops the thread |
| `/attach <path…> [--alt "…"]` | Stage images or a video for the next post |
| `/detach [n\|all]` | Unstage one file, or all of them |
| `/edit [text]` | Write in `$EDITOR` (same as Ctrl+G) |
| `/auto-thread [on\|off]` | Toggle starting a thread from plain text |
| `/settings [undo\|pace N]` | Change the undo window or pace, then show the settings; with no arguments it asks for each |
| `/history` | List this session's posts |
| `/retry` | Resend what couldn't be sent (network error, rate limit or expired session) |
| `/help [command]` | List commands, or show help for one |
| `/exit` (`/quit`) | Leave the REPL (same as Ctrl+D) |

Each post is printed as it's sent: `(4) 3lbx7kt5def2v`, with ` ↳ 1` when it replies to something other than the post before it, and the full `at://` URI with `-v`.

**Refs** name a post: its number (`4`, or `A4` with `-l`, where a bare `4` means that post in the current or last thread), its record key (in your own repo), an `at://` URI or a `https://bsky.app/profile/…/post/…` link.

A name that isn't a command gets a suggestion and your text stays. Command names start with a lowercase letter, so `/Help` and `/ x` are text; start with `\/` to post text that begins like a command.

## Markers and the preview

- `///` splits the text into posts.
- `//>` ends what is sent now; the text after it stays in the composer for next time.
- `<//` cuts the text after it (up to `//>` if there is one); it isn't posted.
- A `\` right before a marker makes it plain text: `\///` is the text `///`, and the backslash isn't counted.

One post within the limit (300, or 298 with the thread label), with no markers, skips the preview and goes straight to the queue. Anything else is previewed first: every post with its count, what is kept for next time and what is cut, then `Post 3? [y/N]`. Only `y` or `Y` posts; any other key leaves what you typed in the composer, command included. Long text without `///` is split for you, and when it is only a little over (301–375) the preview also suggests where to trim it to fit one post. A `///` piece that is still over the limit is refused, and what you typed stays for you to fix.

## Undo window and pacing

- **Undo window:** what you submit waits this long before its first post is sent. Meanwhile the composer shows it dimmed and read-only, with `Sending in 7s… [Esc] cancel  [Enter] send now`. Esc returns it to the composer as you typed it, or saves it as a draft if the composer already had text.
- **Pace:** the minimum time between posts, so a thread doesn't arrive all at once.

Each is none, 5, 10 or 15 seconds. If you haven't set them (`--undo`, `--pace` or the config file), the first thread of a session asks for each, then offers to save your answers: `Yes`, `No`, or `No, don't ask again`.

## Thread label

With `--thread-label` (or `thread-label = true`), every post in the active thread, including replies within it, ends with `🧵` on its own line. `--prepend-thread-label` turns the label on and puts it first instead of last. Posts on their own are never labelled. The label takes 2 characters, so those posts have 298 to work with and the ring shows `/298`.

## Media

`/attach` checks each file, asks for its alt text and stages it. Staged files show above the composer (`📎 chart.png · photo.jpg`) and go on the first post of the next batch, wherever it's going. A post can have up to 4 images of 1 MB each, or one MP4 video of up to 100 MB, never both. These limits come from the `@atproto/api` lexicons, so they rise when it does.

**Alt text** tells people using screen readers what's in your image. Enter skips it, and the file name is used instead. `--alt "…"` uses that text for every file and doesn't ask. With `-f` (or `force-alt = true`) it's required: the prompt asks until it gets some. Esc drops that file.

**Drag and drop:** dropping files on an empty composer asks `Attach chart.png? [Y/n]`. Dropped on text, or if any path isn't a media file, the paths are pasted as text.

If a post with media is rejected, the media is staged again along with the text. If it can't reach Bluesky, the media goes in the draft.

## Scheduled posts and drafts

`/new` → **Scheduled post** gives you a `scheduled ›` prompt. After Enter it asks for a date, a time and, if the hour could be either, AM or PM, then saves the post with any staged media. It goes out through `bsky schedule`, like any other scheduled post, and is a single post of up to 300 characters.

`/new` → **Draft** gives you a `draft ›` prompt and saves what you type, with any staged media, to `bsky drafts`. Long text and `///` make a thread draft.

## When something goes wrong

The REPL never exits on an error.

- **Can't reach Bluesky, or a server error:** the failed post and the rest of its batch are saved as a draft, and the queue pauses. `/retry` sends them now and deletes the draft once they have all gone. Esc clears the pause and leaves the draft; the CLI's usual draft sync offers to send it on your next run.
- **Rate limited:** waited out once if the limit resets within a minute, otherwise as above.
- **Post rejected:** the error is shown, and the failed post and any after it come back as the command that sends them to the same place (`/post …`, `/reply 3 …`). If you've started typing, they're saved as a draft instead.
- **Session expired:** run `bsky login`; unsent posts are saved as a draft.
- **A draft can't be saved:** the posts stay queued for `/retry` or Esc, and nothing is lost.

## Keys

| Key | Action |
|---|---|
| Enter | Submit |
| Shift+Enter, Alt+Enter, Ctrl+J | Newline |
| `\` then Enter, at the end of a line | Newline (the `\` is removed) |
| ←/→, ↑/↓ | Move; ↑ on the first line / ↓ on the last steps through what you've submitted this session, keeping your draft |
| Ctrl+A / Ctrl+E, Home / End | Line start / end |
| Alt+←/→ (Alt+B/F) | Word left / right |
| Ctrl+W, Ctrl+U | Delete word, delete to line start |
| Backspace, Delete | Delete one character |
| Tab | Complete command names |
| Ctrl+G | Open the draft in `$EDITOR` (or `vi`); what you save comes back to the composer |

Esc, Ctrl+C and Ctrl+D act on the innermost thing they can:

| | Esc | Ctrl+C | Ctrl+D |
|---|---|---|---|
| A preview or question is open | Close it (preview text stays) | Same | — |
| Posts are waiting to send, or paused | Cancel them; text and media return to an empty composer, or are saved as a draft. A paused post stays in its draft | Same | — |
| Replying, posting, quoting, scheduling or drafting once | Back to the previous mode | Same | — |
| The composer has text | — | Clear it | — |
| In a thread | Stop the thread | Stop the thread | — |
| Idle | — | Reminds you Ctrl+D exits | — |
| Otherwise | | | Exit; if anything would be lost: `[s]end now · save [d]raft · discard [x] · [Esc] stay` |

`[s]end now` sends what's queued, saves any composer text as a draft, and leaves once everything has gone. While the queue is paused it refuses: `/retry` first, or save a draft.

Pasted text is inserted with its newlines; escape sequences and other control characters are dropped. In terminals with bracketed paste (almost all of them), a paste never submits. Without it, a one-line paste that ends in a newline submits, as it would in a shell.

!!! note "Shift+Enter"
    Shift+Enter needs a terminal that speaks the kitty keyboard protocol, such as iTerm2, Ghostty, kitty or WezTerm (with `enable_kitty_keyboard = true` in its config). Elsewhere the REPL says so once at start; use Alt+Enter or Ctrl+J instead. In macOS Terminal.app, Alt+Enter needs **Use Option as Meta key** (Settings → Profiles → Keyboard).

## Character ring

Below the composer, a ring shows how much of the limit the post under the cursor uses:

| Glyph | Share of the limit |
|---|---|
| `○` | 0–19 % |
| `◔` | 20–49 % |
| `◑` | 50–74 % |
| `◕` | 75–99 % |
| `●` | 100 % or more |

The count turns yellow 40 characters before the limit and red above it, where it shows the overflow: `342/300 (−42)`. With markers, the ring counts the post under the cursor and shows its place (`segment 2/3  ◔ 148/300`), or reads `kept` / `cut` in those parts.

## When you leave

The REPL prints what you posted: `7 posts in 2 threads`, and any drafts that failures left behind. With `-v` it lists every post with its URI, the session's start and end, and every failure.

## Options

| Flag | Description |
|---|---|
| `-t, --auto-thread` | Start a thread when you type plain text |
| `--no-auto-thread` | Don't start a thread from plain text |
| `-l, --prefix-thread` | Label posts per thread (A1, B2…) |
| `--undo <seconds>` | Undo window before each post: 0, 5, 10 or 15 |
| `--pace <seconds>` | Minimum seconds between posts: 0, 5, 10 or 15 |
| `-f, --force-alt` | Require alt text for media |
| `--thread-label` | Add 🧵 to posts in the active thread |
| `--prepend-thread-label` | Put the 🧵 first instead of last |
| `-r, --resume [id]` | Resume a saved session (id, prefix or "last") |
| `--resumable` | Save this session so it can be resumed (default) |
| `-R, --no-resumable` | Don't save this session |

`-r`, `--resumable` and `-R` belong to resumable sessions, which arrive in a later release; until then they print a note when used.

## Configuration

Set defaults in the `[repl]` section of the [config file](configuration.md):

```toml
[repl]
# auto-thread = false
# prefix-thread = false
# undo and pace take 0, 5, 10 or 15 (seconds); left unset, the first thread asks
# undo = 5
# pace = 0
# force-alt = false
# thread-label = false
# prepend-thread-label = false
# ask-to-save = true
# resumable = true
# keep-sessions = 50
# split-marker = "///"
# send-marker = "//>"
# cut-marker = "<//"
```

`ask-to-save = false` stops the offer to save undo and pace answers; choosing "No, don't ask again" sets it for you. `resumable` and `keep-sessions` belong to resumable sessions, which arrive in a later release. Markers must be non-empty text with no spaces, can't start with `/` and a letter (that begins a command), and must differ from each other. Otherwise `bsky repl` stops with an error naming the key and the rule.
