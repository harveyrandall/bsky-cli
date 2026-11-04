# REPL

`bsky repl` opens an interactive composer for writing posts and threads.

!!! info "Preview"
    This release ships the composer itself: it opens, edits text, shows the character ring and runs `/help` and `/exit`. Posting from the REPL arrives in the next release; until then, plain text gets a hint and stays in the composer.

## Starting

```bash
bsky repl
```

The REPL needs an interactive terminal. If stdin or stdout isn't a terminal (for example `bsky repl | tee log`), it prints its help to stderr and exits with status 1.

## Keys

| Key | Action |
|---|---|
| Enter | Submit |
| Shift+Enter, Alt+Enter, Ctrl+J, trailing `\` + Enter | Newline |
| ←/→, ↑/↓ | Move; ↑ on the first line / ↓ on the last steps through what you've sent this session |
| Ctrl+A / Ctrl+E | Line start / end |
| Alt+←/→ (Alt+B/F) | Word left / right |
| Ctrl+W, Ctrl+U | Delete word, delete to line start |
| Backspace, Delete | Delete one character |
| Tab | Complete command names |
| Ctrl+C | Clear the text (on an empty composer, a reminder that Ctrl+D exits) |
| Ctrl+D | Exit; with a draft in the composer, press it twice |

Pasted text is inserted as-is, newlines included, and never submits.

!!! note "Shift+Enter"
    Shift+Enter needs a terminal that speaks the kitty keyboard protocol, such as iTerm2, Ghostty, kitty or WezTerm. Elsewhere the REPL says so once at start; use Alt+Enter or Ctrl+J instead. In macOS Terminal.app, Alt+Enter needs **Use Option as Meta key** (Settings → Profiles → Keyboard).

## Character ring

Below the composer, a ring shows how much of the 300-character limit the text under the cursor uses:

| Glyph | Share of 300 |
|---|---|
| `○` | 0–19 % |
| `◔` | 20–49 % |
| `◑` | 50–74 % |
| `◕` | 75–99 % |
| `●` | 100 % or more |

The count turns yellow from 260 and red above 300, where it shows the overflow: `342/300 (−42)`.

Markers change what the ring counts:

- `///` splits the text into posts. The ring counts the post under the cursor and shows its place, for example `segment 2/3  ◔ 148/300`.
- `//>` ends what will be sent; the text after it is kept for later, and the ring reads `kept`.
- `<//` cuts the text after it, up to `//>` if there is one; the ring reads `cut`.
- A `\` right before a marker makes it plain text: `\///` counts as `///`.

The markers can be changed in the config file (see below).

## Commands

| Command | Description |
|---|---|
| `/help [command]` | List commands, or show help for one |
| `/exit` (`/quit`) | Leave the REPL (same as Ctrl+D) |

An unknown command suggests the closest match and keeps your text so you can fix it.

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

The threading, media and resume flags are accepted now and take effect as those features land.

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

Markers must be non-empty, contain no spaces and differ from each other; otherwise `bsky repl` stops with an error naming the key.
