# Command Reference

All commands support `--json` for structured output and `-p, --profile <name>` for multi-account usage.

## Feed

### `bsky timeline` / `bsky tl`

Display your home timeline.

```bash
bsky tl                     # default feed
bsky tl -n 50               # show 50 posts
bsky tl -H alice.bsky.social  # view another user's feed
bsky tl --json              # JSON output
```

| Flag | Description |
|------|-------------|
| `-H, --handle <handle>` | View a specific user's feed |
| `-n, --count <number>` | Number of posts to show |

### `bsky stream`

Stream the firehose in real time. Optionally filter posts with a regex pattern.

```bash
bsky stream                          # stream everything
bsky stream --pattern "typescript"   # filter by keyword
bsky stream --pattern "rust|go" --pattern-flags "gi"  # case-insensitive
bsky stream -H alice.bsky.social     # stream a specific user
bsky stream --cursor 123             # resume from a cursor
```

| Flag | Description |
|------|-------------|
| `--pattern <regex>` | Filter posts matching this regex |
| `--pattern-flags <flags>` | RegExp flags (default: `gi`). Supported: `g`, `i`, `m`, `s`, `u`, `v`, `d`, `y` |
| `--cursor <value>` | Resume from a specific cursor |
| `-H, --handle <handle>` | Stream a specific user |

!!! warning
    Flags `u` and `v` cannot be used together. Using `y` with `g` will produce a warning (sticky makes global meaningless).

### `bsky thread`

Display a thread starting from a post URI.

```bash
bsky thread at://did:plc:abc123/app.bsky.feed.post/xyz
bsky thread at://did:plc:abc123/app.bsky.feed.post/xyz -n 10
```

| Flag | Description |
|------|-------------|
| `-n, --depth <number>` | Maximum thread depth |

## Posting

### `bsky post`

Create a new post with optional media attachments.

```bash
bsky post "Hello world!"
bsky post "Check this out" -i photo.jpg --image-alt "A photo"
bsky post --stdin < message.txt
bsky post "Watch this" --video clip.mp4 --video-alt "A video clip"
```

| Flag | Description |
|------|-------------|
| `--stdin` | Read post text from stdin |
| `--draft` | Save as draft instead of publishing |
| `-i, --image <path...>` | Attach images (up to 4) |
| `--image-alt <text...>` | Alt text for images (one per image) |
| `--video <path>` | Attach a video |
| `--video-alt <text>` | Alt text for the video |

### `bsky reply`

Reply to an existing post.

```bash
bsky reply at://did:plc:abc123/app.bsky.feed.post/xyz "Great post!"
```

### `bsky quote`

Quote an existing post.

```bash
bsky quote at://did:plc:abc123/app.bsky.feed.post/xyz "This is interesting"
```

### `bsky create-thread`

Create a thread from long text. Text is split at sentence boundaries and posted as a self-reply chain.

```bash
bsky create-thread "Long text that exceeds 300 characters..."
bsky create-thread --stdin < essay.txt
bsky create-thread "Text..." --thread-label          # add 🧵 1/N labels
bsky create-thread "Text..." --draft                 # save as draft
bsky create-thread "Text..." --no-preview            # skip interactive preview
bsky create-thread "Text..." --skip-validation       # bypass 301-375 char edge case
bsky create-thread "Text..." -i a.jpg b.jpg          # distribute images across posts
bsky create-thread "Text..." --reply-to at://...     # first post replies to URI
```

| Flag | Description |
|------|-------------|
| `--stdin` | Read text from stdin |
| `--draft` | Save as draft instead of publishing |
| `--thread-label` | Add 🧵 1/N label to each post |
| `--prepend-thread-label` | Put label at start (default: append) |
| `-i, --image <files...>` | Images distributed across posts in order |
| `--image-alt <alts...>` | Alt text for images |
| `--video <file>` | Video (first post only) |
| `--video-alt <alt>` | Alt text for video |
| `--link <urls...>` | Link embeds distributed across posts |
| `--media-all` | Attach same media to every post |
| `--reply-to <uri>` | First post replies to this URI |
| `--quote <uri>` | First post quotes this URI |
| `--no-preview` | Skip interactive preview |
| `--skip-validation` | Skip edge-case validation for 301-375 char text |

!!! tip
    Text between 301-375 characters triggers an edge case flow. You'll see a split preview and can choose to post anyway, trim the text, or save as a draft. Use `--skip-validation` to skip this and split directly.

!!! info "Interactive preview"
    By default, threads show a preview with commands: `[c]onfirm`, `[e]dit <N>` (opens `$EDITOR`), `[d]elete <N>`, `[q]uit` (offers to save as draft). Disable with `--no-preview` or in non-TTY environments.

!!! info "Partial failure recovery"
    If posting fails mid-thread, the remaining posts are saved as a draft with the reply chain intact. Use `bsky drafts send <id>` to resume.

### `bsky delete`

Delete one or more of your posts.

```bash
bsky delete at://did:plc:abc123/app.bsky.feed.post/xyz
bsky delete <uri1> <uri2> <uri3>
```

## Drafts

Drafts are saved locally when posting fails (network errors, edge cases) or when `--draft` is used. Network drafts are automatically offered for sending next time you run a command while online.

### `bsky drafts list` / `bsky drafts ls`

```bash
bsky drafts list
bsky drafts ls --json
```

### `bsky drafts show`

Show full contents of a draft, including individual posts for thread drafts.

```bash
bsky drafts show <id>
bsky drafts show 1741392    # unique prefix match
```

### `bsky drafts send`

Publish a saved draft. For thread drafts, posts are sent sequentially with reply chaining. Drafts saved from partial failures resume from where they left off.

```bash
bsky drafts send <id>
```

### `bsky drafts delete` / `bsky drafts rm`

```bash
bsky drafts delete <id>
bsky drafts rm <id>
```

## Scheduling

Schedule posts for future publication, with optional recurring support and cross-platform automation.

### `bsky schedule post`

Schedule a post for future publication. You'll be prompted to choose a date and time.

```bash
bsky schedule post "Hello world!"
bsky schedule post "Check this out" -i photo.jpg --image-alt "A photo"
bsky schedule post --stdin < message.txt
```

| Flag | Description |
|------|-------------|
| `--stdin` | Read post text from stdin |
| `-i, --image <path...>` | Attach images (up to 4) |
| `--image-alt <text...>` | Alt text for images |
| `--video <path>` | Attach a video |
| `--video-alt <text>` | Alt text for the video |
| `--repeat <frequency>` | Repeat: `hourly`, `daily`, `fortnightly`, `monthly`, `annually` |
| `--times <count>` | Number of repetitions (number or word, e.g. `5` or `three`) |

#### Recurring posts

Use `--repeat` to create posts that automatically re-schedule after each publication:

```bash
bsky schedule post "Daily update" --repeat daily --times 5
bsky schedule post "Weekly digest" --repeat fortnightly --times "three"
bsky schedule post "Good morning!" --repeat daily              # forever (until deleted)
```

| Frequency | Interval |
|-----------|----------|
| `hourly` | Every hour |
| `daily` | Every day |
| `fortnightly` | Every 2 weeks |
| `monthly` | Every month |
| `annually` | Every year |

When `--times` is omitted, the post repeats indefinitely until manually deleted. You can also leave the interactive "How many times?" prompt blank for the same effect.

!!! info "How recurring posts work"
    Each recurring post is a single file that gets updated in place. After publishing, the scheduled date advances to the next occurrence and the remaining count decrements. On the last occurrence, the file is deleted. Recurrence rules are stored as RFC 5545 RRULE strings.

!!! tip "First-use onboarding"
    The first time you schedule a post, you'll be offered to enable the background scheduler automatically. You can also set it up later with `bsky schedule enable`.

### `bsky schedule list` / `bsky schedule ls`

List scheduled posts, sorted by date (soonest first by default).

```bash
bsky schedule list
bsky schedule ls -a                # show all
bsky schedule list -n 10           # show 10
bsky schedule list -o desc         # latest first
bsky schedule list --json          # JSON output
```

| Flag | Description |
|------|-------------|
| `-n, --number <num>` | Number of posts to show (default: 5) |
| `-a, --all` | Show all scheduled posts |
| `-o, --order <order>` | Sort order: `asc` (default) or `desc` |

### `bsky schedule edit`

Interactively edit a scheduled post's text, date/time, or recurrence.

```bash
bsky schedule edit        # select from list
bsky schedule edit 1      # edit post #1 directly
```

For recurring posts, an additional `(r)ecurrence` option lets you change the frequency, remaining count, or switch between finite and infinite repeat.

### `bsky schedule delete` / `bsky schedule rm`

Delete a scheduled post with confirmation. Offers to save it as a draft.

```bash
bsky schedule delete      # select from list
bsky schedule rm 1        # delete post #1 directly
```

### `bsky schedule run`

Post all scheduled items that are due. Designed for use with external cron jobs or task schedulers.

```bash
bsky schedule run
```

### `bsky schedule watch`

Run a foreground watcher that checks for due posts on a cron schedule. Stays open until you press Ctrl+C.

```bash
bsky schedule watch                             # every minute (default)
bsky schedule watch --interval "*/5 * * * *"    # every 5 minutes
```

| Flag | Description |
|------|-------------|
| `--interval <cron>` | Cron expression (default: `* * * * *`) |

!!! info
    The watcher uses [croner](https://github.com/hexagon/croner) with `protect: true`, which prevents overlapping ticks if a previous check is still running.

### `bsky schedule enable`

Set up an OS-level background scheduler that runs `bsky schedule run` automatically. Works on Linux (crontab), macOS (launchd), and Windows (Task Scheduler).

```bash
bsky schedule enable                  # every 1 minute (default)
bsky schedule enable --interval 5     # every 5 minutes
```

| Flag | Description |
|------|-------------|
| `--interval <minutes>` | Check interval in minutes (default: 1) |

### `bsky schedule disable`

Pause the background scheduler without removing its configuration. The crontab entry, launchd plist, or scheduled task is preserved but deactivated.

```bash
bsky schedule disable
```

### `bsky schedule status`

Show whether the background scheduler is enabled, disabled, or not installed.

```bash
bsky schedule status
bsky schedule status --json
```

### `bsky schedule uninstall`

Permanently remove the background scheduler configuration. Prompts for confirmation (default: no).

```bash
bsky schedule uninstall
```

## Engagement

### `bsky like`

Like one or more posts.

```bash
bsky like at://did:plc:abc123/app.bsky.feed.post/xyz
bsky like <uri1> <uri2>
```

### `bsky likes`

View who liked a post.

```bash
bsky likes at://did:plc:abc123/app.bsky.feed.post/xyz
```

### `bsky repost`

Repost one or more posts.

```bash
bsky repost at://did:plc:abc123/app.bsky.feed.post/xyz
```

### `bsky reposts`

View who reposted a post.

```bash
bsky reposts at://did:plc:abc123/app.bsky.feed.post/xyz
```

## Bookmarks

Bookmarks are stored locally and don't sync to the Bluesky server.

### `bsky bookmarks create`

```bash
bsky bookmarks create at://did:plc:abc123/app.bsky.feed.post/xyz
bsky bookmarks create <uri1> <uri2>
```

### `bsky bookmarks delete`

```bash
bsky bookmarks delete at://did:plc:abc123/app.bsky.feed.post/xyz
```

### `bsky bookmarks get`

```bash
bsky bookmarks get
bsky bookmarks get -n 20
```

## Social

### `bsky follow` / `bsky unfollow`

```bash
bsky follow alice.bsky.social
bsky follow alice.bsky.social bob.bsky.social
bsky unfollow alice.bsky.social
```

### `bsky follows` / `bsky followers`

```bash
bsky follows                        # your follows
bsky follows -H alice.bsky.social   # someone else's follows
bsky followers
bsky followers -H alice.bsky.social
```

### `bsky block` / `bsky unblock` / `bsky blocks`

```bash
bsky block spammer.bsky.social
bsky unblock spammer.bsky.social
bsky blocks                          # list all blocks
```

### `bsky mute`

```bash
bsky mute noisy.bsky.social
```

## Discovery

### `bsky search`

Search for posts.

```bash
bsky search "typescript cli"
bsky search "bluesky api" -n 20
```

### `bsky search-users`

Search for users.

```bash
bsky search-users "alice"
bsky search-users "developer" -n 10
```

## Account

### `bsky profile`

View profile information.

```bash
bsky profile                        # your profile
bsky profile -H alice.bsky.social   # someone else's
```

### `bsky profile-update`

Update your profile.

```bash
bsky profile-update "Display Name" "Bio text"
bsky profile-update --avatar photo.jpg
bsky profile-update --banner banner.jpg
```

### `bsky session`

View the current session information.

### `bsky notifs` / `bsky notification`

View notifications.

```bash
bsky notifs
bsky notifs -a    # show all (including read)
```

### `bsky invite-codes`

View your invite codes.

```bash
bsky invite-codes
bsky invite-codes --used    # include used codes
```

### `bsky app-password`

Manage app passwords.

```bash
bsky app-password list
bsky app-password add
bsky app-password revoke
```

### `bsky report`

Report a user.

```bash
bsky report spammer.bsky.social --comment "Spam account"
```

### `bsky mod-list`

Create a moderation list.

```bash
bsky mod-list user1.bsky.social user2.bsky.social --name "My Block List" --desc "Spammers"
```

## Global Flags

These flags work with all commands:

| Flag | Description |
|------|-------------|
| `--json` | Output as JSON |
| `-p, --profile <name>` | Use a named profile |
| `-v, --verbose` | Verbose output |
| `--version` | Show version |
| `--help` | Show help |
