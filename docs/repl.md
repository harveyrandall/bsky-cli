# REPL

`bsky repl` opens an interactive composer for posts, threads, quotes, scheduled posts and drafts, where you can also read your timeline and act on what you read. In a terminal, plain `bsky` with no command opens it too.

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
| `/new` | Pick what to write next: `Post · Thread · Image post · Video post · Quote post · Scheduled post · Draft`. Picking one stops the thread. Like `/thread` and `/reply-from`, it's refused while anything is queued |
| `/attach <path…> [--alt "…"]` | Stage images or a video for the next post |
| `/detach [n\|all]` | Unstage one file (counting from 1, in the order shown above the composer), or all of them, which is what `/detach` alone does |
| `/edit [text]` | Write in `$EDITOR` (same as Ctrl+G) |
| `/delete <ref>` | Delete one of your posts, after asking. A thread that was continuing from it goes back to the post before, or stops if there isn't one, and deleting a thread's first post stops the thread, as the question says, and gives you the command to carry on from what's left. Refused while anything is queued |
| `/undo` | Delete the last post you made this session, after asking. Refused while anything is queued: wait, or Esc takes back what hasn't gone yet |
| `/drafts [id]` | List your drafts, or load one into the composer by its id or the start of it |
| `/switch [profile]` | Post as another account, or with no name, the unnamed profile's. See [Switching account](#switching-account) |
| `/like`, `/unlike`, `/repost`, `/unrepost <ref>` | Like or repost a post, or take it back |
| `/open <ref>` | Open a post in your browser |
| `/copy <ref>` | Copy a post's link |
| `/view <ref>` | Print a post and its replies |
| `/run <command> [args]` | Run a CLI command, even one whose name a REPL command has taken |
| `/auto-thread [on\|off]` | Toggle starting a thread from plain text |
| `/settings [name value]` | Change a setting for this session, then show the settings: `undo` or `pace` with 0, 5, 10 or 15, `force-alt` or `verbose` with `on` or `off`, or `thread-label` with `off`, `append` or `prepend`. With no arguments it asks for the undo window and pace |
| `/history` | List this session's posts, marking any you've deleted |
| `/retry` | Resend what couldn't be sent (network error, rate limit or expired session) |
| `/help [command]` | List commands, or show help for one |
| `/exit` (`/quit`) | Leave the REPL (same as Ctrl+D) |

Each post is printed as it's sent: `(4) 3lbx7kt5def2v`, with ` ↳ 1` when it replies to something other than the post before it, `📷 2` or `🎞` for media, `❝ 2` for a quote, and the full `at://` URI with `-v`.

**Refs** name a post: its number (`4`, or `A4` with `-l`, where a bare `4` means that post in the current or last thread), a `#n` label from something you've read, its record key (in your own repo), an `at://` URI or a `https://bsky.app/profile/…/post/…` link.

A name that isn't a command gets a suggestion and your text stays. Anything that starts with `/` and a letter counts, so a mistyped `/Exit` is caught rather than posted, while `/ x` is text. Start with `\/` to post text that begins like a command.

## Reading and CLI commands

Most CLI commands run from the prompt, without the `bsky`: `/timeline -n 5`, `/tl`, `/notifs`, `/search cats`. `/help` lists them on its `↗ From the CLI` line. A REPL command of the same name goes first, so use `/run drafts list` for the CLI's `drafts`. The current profile and any `-c` you started with are used, and a command that fails never ends the REPL: its error is shown and its text stays in the composer.

Posts that `timeline`, `thread`, `search`, `bookmarks get` and `/view` print get a `#n` label, or their `(n)` if they're already in the session. It works as a ref and lasts for the session, including when you resume it. `/notifs` and `--json` output have no labels.

```
/timeline -n 2
#1 alice.bsky.social ...
#2 bob.bsky.social ...
/like #2
/reply #1 Nice one
```

In a CLI command's arguments, a `#n` becomes its post's `at://` URI only where the command takes a post, as in `/run thread #1`. Anywhere else it stays as you typed it, so `/run post we are #1` posts those words, and a bare number is left alone.

Commands that need the terminal to themselves refuse, with a hint: `repl`, `login`, `stream`, `create-thread`, `config edit`, and `schedule post`, `edit`, `delete`, `uninstall` and `watch`. So does `--stdin` on any command. The hint says what to use instead, usually another terminal. A refused `/login` also clears the composer and stays out of ↑ history, as it may hold a password.

## Switching account

`/switch <profile>` opens the profile's saved login and posts as that account from then on. Drafts, scheduled posts, CLI commands and the session file all follow it. A handle works in place of a profile's name, and `/switch` or `/switch default` goes back to the unnamed profile. `/switch ?` lists the profiles.

It's refused while anything is queued. Everything tied to the old account stops: the thread ends, a reply or quote prompt closes and staged media is unstaged, with a note saying which files. If it turns out to be the same account, nothing stops. Numbers, `#n` labels, URIs and links still reach the old account's posts: `/delete` refuses them and `/undo` skips them. If the profile can't be opened, nothing changes.

With `BSKY_HANDLE` and `BSKY_PASSWORD` set, those choose the account, so `/switch` is refused.

## Markers and the preview

- `///` splits the text into posts.
- `//>` ends what is sent now; the text after it stays in the composer for next time.
- `<//` cuts the text after it (up to `//>` if there is one); it isn't posted.
- A `\` right before a marker makes it plain text: `\///` is the text `///`, and the backslash isn't counted.

One post within the limit (300, or 298 with the thread label), with no markers, skips the preview and goes straight to the queue. Anything else is previewed first: every post with its count, any staged files, what is kept for next time and what is cut, then `Post 3? [y/N]`. Only `y` or `Y` posts; any other key leaves what you typed in the composer, command included. Long text without `///` is split for you, and when it is only a little over (301–375) the preview also suggests where to trim it to fit one post. A `///` piece that is still over the limit is refused, and what you typed stays for you to fix. The `scheduled ›` and `draft ›` prompts skip the preview, but refuse anything over the limit in the same way.

## Undo window and pacing

- **Undo window:** what you submit waits this long before its first post is sent. Meanwhile the composer shows it dimmed and read-only, with `Sending in 7s… [Esc] cancel  [Enter] send now`. Esc returns it, with any media, to the composer as you typed it, or saves it as a draft if the composer already had text.
- **Pace:** the minimum time between posts, so a thread doesn't arrive all at once.

Each is none, 5, 10 or 15 seconds. If you haven't set them (`--undo`, `--pace` or the config file), the first thread of a session asks for each, then offers to save your answers: `Yes`, `No`, or `No, don't ask again`.

## Thread label

With `--thread-label` (or `thread-label = true`), every post in the active thread, including replies within it, ends with `🧵` on its own line. `--prepend-thread-label` turns the label on and puts it first instead of last. Posts on their own are never labelled. The label takes 2 characters, so those posts have 298 to work with and the ring shows `/298`.

## Media

`/attach` checks each file, asks for its alt text and stages it. `/new` → **Image post** or **Video post** does the same from a path, then opens a `post ›` prompt. Staged files show above the composer (`📎 chart.png · photo.jpg`) and go on the first post of the next batch, wherever it's going. The exception is a quote, which can't carry media: it goes without, and the files stay staged for the next post. Posts need text, so Enter with only a file staged does nothing but say so.

A post can have up to 4 JPEG, PNG, GIF or WebP images of 1 MB each, or one MP4 video of up to 100 MB, never both. These limits come from the `@atproto/api` lexicons, so they rise when it does. Paths are stored in full, but the file must still be there when a draft or scheduled post goes out.

**Alt text** tells people using screen readers what's in your image. Enter skips it, and the file name is used instead. `--alt "…"` uses that text for every file and doesn't ask. With `-f` (or `force-alt = true`) it's required: the prompt asks until it gets some. With or without `-f`, Esc leaves that file out.

**Drag and drop:** in terminals with bracketed paste, dropping files on an empty composer asks `Attach chart.png? [Y/n]`, and a file that's too big says so when you answer. Any answer but Enter or `y` pastes the paths as text. So does dropping on text, or dropping anything that isn't an image or MP4 video.

If the first post of a batch is rejected, its media is staged again and the text comes back to the composer. If you've started typing, or the media can't join what's staged since, they go to a draft together. If it can't reach Bluesky, the media goes in the draft.

## Scheduled posts and drafts

`/new` → **Scheduled post** gives you a `scheduled ›` prompt. After Enter it asks for a date, a time and, if the hour could be either, AM or PM, then saves the post with any staged media. It's a single post of up to 300 characters, saved for `bsky schedule`. Nothing sends it until `bsky schedule run` runs for that account, so use [`bsky schedule enable`](commands.md#bsky-schedule-enable) or keep `bsky schedule watch` open; the REPL says so if no scheduler is enabled for it. There's one scheduler per machine, and it sends one profile's posts.

`/new` → **Draft** gives you a `draft ›` prompt and saves what you type, with any staged media, as a draft. Long text and `///` make a thread draft. Send it later with `bsky drafts send <id>`, or load it with `/drafts <id>`.

`/drafts <id>` puts the draft in the composer as the command that sends it (`/post …`, `/reply … …`, `/quote … …`), with a thread's posts joined by `///`, and stages its media. Once that text has been sent, the draft is deleted. Until then it stays: change the text, cancel in the undo window or have the server refuse it, and it's still there. A draft whose media can't be found won't load, and neither will a thread with media on its later posts, so use `bsky drafts send` for those.

## When something goes wrong

The REPL never exits on an error.

- **Can't reach Bluesky, or a server error:** the failed post and the rest of its batch are saved as a draft, and the queue pauses. `/retry` sends them now and deletes the draft once they have all gone. Esc clears the pause and leaves the draft; the CLI's usual draft sync offers to send it on your next run.
- **Rate limited:** waited out once if the limit resets within a minute, otherwise as above.
- **Post rejected:** the error is shown, and the failed post and any after it come back as the command that sends them to the same place (`/post …`, `/reply 3 …`, `/quote 3 …`). If you've started typing, they're saved as a draft instead.
- **Session expired:** unsent posts are saved as a draft. Exit and reopen the REPL; if it still says so, run `bsky login`.
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
| Tab | Complete command names, then long flags, `/attach` paths (`~/` works, and spaces are escaped for you) and recent labels after commands that take a `<ref>`. Inside an open quote it does nothing |
| Ctrl+G | Open the draft in `$EDITOR` (or `vi`); what you save comes back to the composer. Use a waiting form for a GUI editor (`code --wait`). If the editor fails, your text stays as it was. Nothing is sent until it closes |

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

`[s]end now` sends what's queued, saves any composer text and staged media as a draft, and leaves once everything has gone. While the queue is paused it refuses: `/retry` first, or save a draft.

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

The REPL prints what you posted and how to come back: `7 posts in 2 threads · resume: bsky -r k3f7xq`, and any drafts that failures left behind. With `-v` it lists every post with its URI, the session's start and end, and every failure. Posts you deleted aren't counted; `-v` lists them under `Deleted:`.

## Resuming

The REPL saves your session as you go, so a closed terminal or a crash costs you at most the last second of typing. When you start it and saved sessions exist, it asks which to open:

```
Resume a session?
› + new
  2026-10-31T14:05:22  k3f7xq  @you · 2 threads, 7 posts · "Launch day! Here's what…"
  2026-10-30T21:40:03  p2m2wd  @you · 1 thread, 3 posts · "Thinking about lexicons…"
```

Enter on `+ new` starts afresh, as does Esc; Ctrl+C quits. A session open in another REPL shows `in use` and can't be opened, and a file the REPL can't read shows `unreadable`, with `d` to delete it. To skip the list, use `bsky -r last` (the newest session free to open), an id (`bsky -r k3f7xq`) or enough of one to be unique (`bsky -r k3f`). The keyboard waits until the session is back, which can take up to ten seconds on a slow connection.

| What's restored | How |
|---|---|
| Your posts and their labels | Replayed under `── resumed k3f7xq ──`; numbering carries on |
| `#n` labels | Kept, and new ones carry on from the saved count |
| The thread | From its last post, or the nearest one that can still be found. If none can, the thread stops |
| The mode, the composer and ↑ history | As you left them, along with which draft the composer came from |
| Staged files | Those still usable; the rest are dropped, with a message saying which and why |
| Settings and markers | The session's own, whatever flags you start with. The settings are printed as it opens, with any flags that changed nothing and what to run to use them. That covers `-p` and `-R` too |
| Unsent posts | Each asks `Send · Edit · Discard`, and nothing goes out until you choose. They stay saved until you've answered |

`Edit` is selected first, because an unsent post can be one that was sending when the terminal closed, which may already have gone: check before choosing `Send`. `Send` starts its undo window again. `Edit` or Esc puts it back in the composer, or saves it as a draft if there's text there already or its media won't fit. If its thread couldn't be found, the question says so, and `Send` then asks whether to start a new thread, which is selected first, or paste a link to a post to continue from. The post has to still be there, and Esc or an empty link counts as `Edit`. Once you've answered, the rest of that thread's unsent posts that you send follow it, without asking again.

A session opens under the profile it was started with, whatever `-p` you give, and is refused if that profile is logged in to another account. Text you were typing is saved after a second's pause. Sessions are kept in `repl/sessions/` in the [config folder](configuration.md), readable only by you, with no tokens in them. Empty sessions aren't kept. When a REPL exits, sessions beyond the newest `keep-sessions` (50 by default) are removed, unless they have unsent posts or can't be read. `-R` saves nothing and leaves the resume hint out of the exit summary. Unless you also use `-r`, it skips the list; a session you resume keeps saving, so your answers aren't asked again.

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
| `-r, --resume [id]` | Resume a saved session: an id, a prefix or "last"; with no id, show the list |
| `--resumable` | Save this session so it can be resumed (default) |
| `-R, --no-resumable` | Don't save this session |

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

`ask-to-save = false` stops the offer to save undo and pace answers; choosing "No, don't ask again" sets it for you. `resumable = false` is the same as `-R`, and `keep-sessions` sets how many saved sessions to keep, a whole number above 0. Markers must be non-empty text with no spaces, can't start with `/` and a letter (that begins a command), and must differ from each other. Otherwise `bsky repl` stops with an error naming the key and the rule.
