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
