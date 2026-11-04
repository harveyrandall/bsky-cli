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
| `thread ›`, `thread (4) ›` | thread | The next post, replying to the last one (`(4)`) |
| `thread A (A4) ›` | thread, with `-l` | The same, with lettered labels |
| `reply→2 ›` | reply once | A reply to post 2, then back to the previous mode |
| `post ›` | post once | A post on its own, then back |

| Command | Does |
|---|---|
| `/thread [text\|ref]` | Start a thread (its first post, if you give text), or continue the thread a ref points to. `/thread "42"` posts the text `42`. Options `--undo N` and `--pace N` go first. |
| `/reply <ref> [text]` | Reply once — now with text, or to whatever you type next |
| `/reply-from <ref>` | Continue the thread from another post |
| `/post [text]` | Post on its own |
| `/auto-thread [on\|off]` | Toggle starting a thread from plain text |
| `/settings [undo\|pace N]` | Show or change the undo window and pace; with no arguments it asks for each |
| `/history` | List this session's posts |
| `/retry` | Resend the last batch that couldn't reach Bluesky |
| `/help [command]` | List commands, or show help for one |
| `/exit` (`/quit`) | Leave the REPL (same as Ctrl+D) |

Each post is printed as it's sent: `(4) 3lbx7kt5def2v`, with ` ↳ 1` when it replies to something other than the post before it, and the full `at://` URI with `-v`.

**Refs** name a post: its number (`4`, or `A4` with `-l`), its record key, an `at://` URI or a `https://bsky.app/profile/…/post/…` link.

## Markers and the preview

- `///` splits the text into posts.
- `//>` ends what is sent now; the text after it stays in the composer for next time.
- `<//` cuts the text after it (up to `//>` if there is one); it isn't posted.
- A `\` right before a marker makes it plain text: `\///` is the text `///`, and the backslash isn't counted.

One post of 300 characters or fewer, with no markers, is sent straight away. Anything else is previewed first: every post with its count, what is kept for next time and what is cut, then `Post 3? [y/N]`. Only `y` posts; any other key returns the text to the composer as you typed it. Long text without `///` is split for you, and when it is only a little over (301–375) the preview also suggests where to trim it to fit one post. A `///` piece that is still over the limit is refused, and the text stays for you to fix.

## Undo window and pacing

- **Undo window:** a post waits this long before it is sent. It shows dimmed with `Sending in 7s… [Esc] cancel  [Enter] send now`; Esc puts it back in the composer.
- **Pace:** the minimum time between posts, so a thread doesn't arrive all at once.

Each is none, 5, 10 or 15 seconds. If you haven't set them (`--undo`, `--pace` or the config file), the first thread of a session asks for each, then offers to save your answers: `Yes`, `No`, or `No, don't ask again`.

## Thread label

With `--thread-label` (or `thread-label = true`), every post in the active thread ends with `🧵` on its own line — first instead of last with `--prepend-thread-label`. Posts on their own are never labelled. The label takes 2 characters, so those posts have 298 to work with and the ring shows `/298`.

## When something goes wrong

The REPL never exits on an error.

- **Can't reach Bluesky:** the failed post and the rest of its batch are saved as a draft, and the queue pauses. `/retry` sends them now (and deletes the draft); the CLI's usual draft sync sends them on your next run otherwise.
- **Rate limited:** retried once automatically if the limit resets within a minute, otherwise as above.
- **Post rejected:** the error is shown and the text comes back to the composer.
- **Session expired:** run `bsky login`; unsent posts are saved as a draft.

## Keys

| Key | Action |
|---|---|
| Enter | Submit |
| Shift+Enter, Alt+Enter, Ctrl+J | Newline |
| `\` then Enter, at the end of a line | Newline (the `\` is removed) |
| ←/→, ↑/↓ | Move; ↑ on the first line / ↓ on the last steps through the commands you've run this session, keeping your draft |
| Ctrl+A / Ctrl+E, Home / End | Line start / end |
| Alt+←/→ (Alt+B/F) | Word left / right |
| Ctrl+W, Ctrl+U | Delete word, delete to line start |
| Backspace, Delete | Delete one character |
| Tab | Complete command names |

Esc, Ctrl+C and Ctrl+D act on the innermost thing they can:

| | Esc | Ctrl+C | Ctrl+D |
|---|---|---|---|
| A preview or question is open | Close it (preview text returns) | Same | — |
| Posts are waiting to send | Cancel them; text returns to an empty composer, or is saved as a draft | Same | — |
| Replying or posting once | Back to the previous mode | Same | — |
| The composer has text | — | Clear it | — |
| In a thread | Stop the thread | Stop the thread | — |
| Idle | — | Reminds you Ctrl+D exits | — |
| Anywhere | | | Exit; if anything would be lost: `[s]end now · save [d]raft · discard [x] · [Esc] stay` |

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

The REPL prints what you posted: `7 posts in 2 threads`. With `-v` it lists every post with its URI, the session's start and end, and any failures with their draft ids.

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

`-f`, `-r`, `--resumable` and `-R` belong to media and resumable sessions, which arrive in later releases; until then they print a note when used.

## Configuration

Set defaults in the `[repl]` section of the [config file](configuration.md):

```toml
[repl]
# auto-thread = false
# prefix-thread = false
# undo and pace take 0, 5, 10 or 15 (seconds); the values below are examples, not defaults
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
