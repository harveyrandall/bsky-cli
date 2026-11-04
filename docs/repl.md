# REPL

`bsky repl` opens an interactive composer for writing posts and threads.

!!! info "Preview"
    This release ships the composer itself: it opens, edits text, shows the character ring and runs `/help` and `/exit`. Posting from the REPL arrives in a later release; until then, plain text gets a hint and stays in the composer.

## Starting

```bash
bsky repl
```

The REPL needs an interactive terminal. If stdin or stdout isn't a terminal (for example `bsky repl | tee log`), it says so, prints its help to stderr and exits with status 1. Flags that aren't used yet print a note when you pass them.

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
| Ctrl+C | Clear the text (on an empty composer, a reminder that Ctrl+D exits) |
| Ctrl+D | Exit; with a draft in the composer, press it twice |

Pasted text is inserted with its newlines; escape sequences and other control characters are dropped. In terminals with bracketed paste (almost all of them), a paste never submits. Without it, a one-line paste that ends in a newline submits, as it would in a shell.

!!! note "Shift+Enter"
    Shift+Enter needs a terminal that speaks the kitty keyboard protocol, such as iTerm2, Ghostty, kitty or WezTerm (with `enable_kitty_keyboard = true` in its config). Elsewhere the REPL says so once at start; use Alt+Enter or Ctrl+J instead. In macOS Terminal.app, Alt+Enter needs **Use Option as Meta key** (Settings → Profiles → Keyboard).

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
- A `\` right before a marker makes it plain text: `\///` is the text `///`, and the backslash isn't counted.

The markers can be changed in the config file (see below).

## Commands

| Command | Description |
|---|---|
| `/help [command]` | List commands, or show help for one |
| `/exit` (`/quit`) | Leave the REPL (same as Ctrl+D) |

An unknown command suggests a close match, if there is one, and keeps your text so you can fix it. A command name starts with a lowercase letter; anything else after `/` is plain text.

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

These flags are accepted now so `--help` and shell completions list them, but none of them takes effect yet; each starts working when its feature ships.

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

`ask-to-save` and `keep-sessions` belong to features that arrive in later releases. Markers must be non-empty text with no spaces, can't start with `/` and a letter (that begins a command), and must differ from each other. Otherwise `bsky repl` stops with an error naming the key and the rule.
