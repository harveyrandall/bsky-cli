# bsky-cli

A command-line client for [Bluesky](https://bsky.app), built with TypeScript.

## Install

Requires Node.js >= 22.

```bash
git clone https://github.com/yourusername/bsky-cli.git
cd bsky-cli
yarn install
yarn build
yarn link:global   # registers `bsky` globally
```

To uninstall:

```bash
yarn unlink:global
```

## Authentication

### Interactive login

```bash
bsky login alice.bsky.social            # prompts for password (hidden input)
bsky login alice.bsky.social mypassword  # or pass directly
```

### Environment variables

All configuration can be set via environment variables, useful for CI and scripts:

| Variable | Description |
|----------|-------------|
| `BSKY_HANDLE` | Bluesky handle |
| `BSKY_PASSWORD` | App password |
| `BSKY_HOST` | PDS host URL (default: `https://bsky.social`) |
| `BSKY_BGS` | BGS host URL (default: `https://bsky.network`) |
| `BSKY_PROFILE` | Profile name (same as `--profile`) |

Precedence: CLI args > environment variables > config file.

```bash
# No login needed - authenticate directly from env
BSKY_HANDLE=alice.bsky.social BSKY_PASSWORD=secret bsky tl
```

### Piped input

```bash
echo "$APP_PASSWORD" | bsky login alice.bsky.social
```

### Multiple accounts

Use `--profile` / `-p` to manage separate accounts:

```bash
bsky login alice.bsky.social -p personal
bsky login bob.bsky.social -p work

bsky tl -p personal
bsky tl -p work
bsky -p ? tl              # list all profiles
```

## Commands

### Feed

```
bsky timeline|tl [-H handle] [-n count]
bsky stream [--cursor] [-H handle] [--pattern regex] [--reply text]
bsky thread <uri> [-n depth]
```

### Posting

```
bsky post <text> [--stdin] [-i image...] [--image-alt alt...] [--video path] [--video-alt alt]
bsky reply <uri> <text>
bsky quote <uri> <text>
bsky delete <uri...>
```

### Engagement

```
bsky like <uri...>
bsky likes <uri>
bsky repost <uri...>
bsky reposts <uri>
```

### Bookmarks

```
bsky bookmarks create <uri...>
bsky bookmarks delete <uri...>
bsky bookmarks get [-n count]
```

### Social

```
bsky follow <handle...>
bsky unfollow <handle...>
bsky follows [-H handle]
bsky followers [-H handle]
bsky block <handle...>
bsky unblock <handle...>
bsky blocks
bsky mute <handle...>
```

### Discovery

```
bsky search <terms...> [-n count]
bsky search-users <terms...> [-n count]
```

### Account

```
bsky profile [-H handle]
bsky profile-update [displayname] [description] [--avatar file] [--banner file]
bsky session
bsky notifs|notification [-a]
bsky invite-codes [--used]
bsky app-password list|add|revoke
bsky report <handle> [--comment text]
bsky mod-list <handles...> [--name] [--desc]
```

### Utilities

```
bsky completions bash|zsh|fish
```

## Global flags

| Flag | Description |
|------|-------------|
| `--json` | Output as JSON |
| `-p, --profile <name>` | Use a named profile |
| `-v, --verbose` | Verbose output |
| `--version` | Show version |

## Shell completions

```bash
# Bash
bsky completions bash >> ~/.bashrc

# Zsh
bsky completions zsh >> ~/.zshrc

# Fish
bsky completions fish > ~/.config/fish/completions/bsky.fish
```

## Development

```bash
yarn dev             # run via tsx (no build needed)
yarn build           # build to dist/
yarn typecheck       # tsc --noEmit
yarn link:global     # build + register globally
yarn unlink:global   # remove global symlink
```

## License

MIT
