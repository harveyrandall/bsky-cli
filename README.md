# bsky-cli

<!-- badges -->
[![CI](https://github.com/harveyrandall/bsky-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/harveyrandall/bsky-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@harveyrandall/bsky-cli)](https://www.npmjs.com/package/@harveyrandall/bsky-cli)
[![license](https://img.shields.io/github/license/harveyrandall/bsky-cli)](LICENSE.md)
[![downloads](https://img.shields.io/npm/dm/@harveyrandall/bsky-cli)](https://www.npmjs.com/package/@harveyrandall/bsky-cli)

> [!CAUTION]
> **Versions 1.5.0 and earlier stored credentials in plaintext.** Upgrade to v1.6.0 or later immediately. If you were on an affected version, change your Bluesky app password after upgrading.

A command-line client for [Bluesky](https://bsky.app), built with TypeScript.

## Install

### npm / yarn / pnpm / bun

Requires Node.js >= 22.

```bash
npm install -g @harveyrandall/bsky-cli
# or
yarn global add @harveyrandall/bsky-cli
# or
pnpm add -g @harveyrandall/bsky-cli
# or
bun add -g @harveyrandall/bsky-cli
```

### Homebrew (macOS / Linux)

```bash
brew install harveyrandall/bsky-cli/bsky-cli
```

### Download a binary

Standalone binaries for macOS, Linux, and Windows are attached to every
[GitHub Release](https://github.com/harveyrandall/bsky-cli/releases).

<details>
<summary>Build from source</summary>

```bash
git clone https://github.com/harveyrandall/bsky-cli.git
cd bsky-cli
corepack enable
yarn install
yarn build
yarn link:global   # registers `bsky` globally
```

To uninstall:

```bash
yarn unlink:global
```

</details>

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
| `BSKY_CONFIG` | Path to config file (same as `--config`) |

Precedence: CLI args > environment variables > config file > defaults.

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

## Data storage

bsky-cli stores session tokens (never passwords) in platform-appropriate locations:

| Platform | Default path | Override |
|----------|-------------|----------|
| **macOS** | `~/Library/Application Support/bsky-cli/` | `$XDG_CONFIG_HOME/bsky-cli/` |
| **Linux** | `~/.config/bsky-cli/` | `$XDG_CONFIG_HOME/bsky-cli/` |
| **Windows** | `%APPDATA%\bsky-cli\` | `$XDG_CONFIG_HOME/bsky-cli/` |

Files stored:
- `session.json` — session tokens (did, handle, accessJwt, refreshJwt) with `0o600` permissions
- `session-{profile}.json` — per-profile sessions
- `drafts/` — locally saved drafts
- `scheduled/` — scheduled posts (one JSON file per post)

Where available, session tokens are also stored in the OS keychain
(macOS Keychain, GNOME Keyring/libsecret, Windows Credential Manager)
with filesystem as fallback.

Passwords are **never** saved to disk. They are used only during `bsky login`
to obtain session tokens, then discarded from memory.

## Commands

### Feed

```
bsky timeline|tl [-H handle] [-n count]
bsky stream [--cursor] [-H handle] [--pattern regex] [--pattern-flags flags]
bsky thread <uri> [-n depth]
```

### Posting

```
bsky post <text> [--stdin] [-i image...] [--image-alt alt...] [--video path] [--video-alt alt]
bsky reply <uri> <text>
bsky quote <uri> <text>
bsky delete <uri...>
```

### Threads

```
bsky create-thread <text> [--stdin] [--thread-label] [--draft] [--no-preview]
                          [--split-on <marker>] [--skip-validation]
```

Splits long text into a thread. Uses `///` as the default manual split marker:

```bash
bsky create-thread "First post /// Second post /// Third post"
bsky create-thread "Part A --- Part B" --split-on "---"
bsky create-thread --stdin < essay.txt --thread-label
```

### Drafts

```
bsky drafts list
bsky drafts show <id>
bsky drafts send <id>
bsky drafts delete <id>
```

### Scheduling

```
bsky schedule post <text> [--repeat freq] [--times count]
bsky schedule list|ls [-n count] [-a] [-o asc|desc]
bsky schedule edit [index]
bsky schedule delete|rm [index]
bsky schedule run
bsky schedule watch [--interval cron]
bsky schedule enable [--interval minutes]
bsky schedule disable
bsky schedule status
bsky schedule uninstall
```

### Engagement

```
bsky like <uri...>
bsky unlike <uri...>
bsky likes <uri>
bsky repost <uri...>
bsky remove-repost|unrepost <uri...>
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
bsky config init|path|show|edit
```

## Global flags

| Flag | Description |
|------|-------------|
| `--json` | Output as JSON |
| `-p, --profile <name>` | Use a named profile |
| `-v, --verbose` | Verbose output |
| `-c, --config <path>` | Path to config file |
| `--version` | Show version |

## Configuration

bsky-cli supports a TOML config file for persistent defaults. CLI flags always override config values.

```bash
# Create default config
bsky config init

# Open in your editor
bsky config edit

# Use a custom config file
bsky -c /path/to/config.toml timeline
```

The config file lives at the platform default: `~/.config/bsky-cli/config.toml` (Linux), `~/Library/Application Support/bsky-cli/config.toml` (macOS), or `%APPDATA%/bsky-cli/config.toml` (Windows).

Precedence: **CLI flags > environment variables > config file > defaults**

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
yarn test:run        # run tests once
yarn test:coverage   # run tests with coverage
yarn link:global     # build + register globally
yarn unlink:global   # remove global symlink
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contributor guide.

## Roadmap

- [x] Threads with automatic and manual splitting
- [x] Drafts with offline sync and partial failure recovery
- [x] Secure credential storage (OS keychain + session tokens, no plaintext passwords)
- [x] Scheduled and recurring posts with cross-platform automation
- [ ] List creation and management
- [ ] Starter packs
- [ ] Moderation lists
- [ ] Post labels
- [ ] Auto alt-text for images and videos
- [ ] OAuth login support
- [ ] Docker BuildKit for standalone binary builds

## License

[MIT](LICENSE.md)
