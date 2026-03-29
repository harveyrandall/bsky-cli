# Configuration

## Config file

bsky-cli supports a TOML config file for setting persistent defaults. This lets you avoid passing the same flags on every command.

The config file is located at the platform default config directory:

| Platform | Path |
|----------|------|
| **Linux** | `~/.config/bsky-cli/config.toml` |
| **macOS** | `~/Library/Application Support/bsky-cli/config.toml` |
| **Windows** | `%APPDATA%/bsky-cli/config.toml` |

If `$XDG_CONFIG_HOME` is set, it takes priority: `$XDG_CONFIG_HOME/bsky-cli/config.toml`.

### Creating the config file

```bash
bsky config init
```

This creates the config file with all available options documented and commented out. Uncomment any option to activate it.

### Managing the config

```bash
# Print the config file path
bsky config path

# Print the config file contents
bsky config show

# Open in your editor ($EDITOR, falls back to vi)
bsky config edit
```

### Using a custom config file

Override the config file path with `-c` / `--config` or the `BSKY_CONFIG` environment variable:

```bash
# Flag (highest priority)
bsky -c /path/to/config.toml timeline

# Environment variable
export BSKY_CONFIG=/path/to/config.toml
bsky timeline
```

Precedence for config path: `-c` flag > `BSKY_CONFIG` env var > default location.

### Config file format

The config file uses [TOML](https://toml.io) format. Global options go at the top, and each command has its own `[section]`:

```toml
# Global options
json = false
profile = "work"
verbose = false

# Per-command options
[create-thread]
thread-label = true
no-preview = true

[timeline]
count = 50

[schedule.list]
count = 10
order = "desc"
```

!!! tip "CLI flags always win"
    Any flag passed on the command line overrides the config file value. For example, if your config sets `json = true`, running `bsky tl --no-json` will still output plain text.

### Full schema reference

Below is the complete config file with all available options and their defaults. All values are commented out by default — uncomment to activate.

```toml
# bsky-cli configuration
# CLI flags always override these values.
# Uncomment and modify options as needed.

# ── Global ──────────────────────────────────────
# json = false
# profile = ""
# verbose = false

# ── Commands ────────────────────────────────────

[post]
# stdin = false
# draft = false

[reply]
# draft = false

[quote]
# draft = false

[create-thread]
# stdin = false
# draft = false
# thread-label = false
# prepend-thread-label = false
# no-preview = false
# skip-validation = false
# media-all = false

[timeline]
# count = 30

[stream]
# pattern-flags = "gi"

[search]
# count = 100

[search-users]
# count = 100

[thread]
# count = 30

[notifs]
# all = false

[login]
# host = "https://bsky.social"
# bgs = "https://bsky.network"

[invite-codes]
# used = false

[mod-list]
# name = "NewList"
# desc = ""

[bookmarks.get]
# count = 50

[schedule.list]
# count = 5
# order = "asc"

[schedule.watch]
# interval = "* * * * *"

[schedule.enable]
# interval = 1

[schedule.post]
# stdin = false
```

## Session data

Credentials and session tokens are stored separately from the config file, in the same config directory. Each profile gets its own session file.

The session directory is created automatically on first `bsky login`.

## Environment variables

All configuration can be set via environment variables. This is useful for CI pipelines, scripts, and Docker containers.

| Variable | Description | Default |
|----------|-------------|---------|
| `BSKY_HANDLE` | Bluesky handle | — |
| `BSKY_PASSWORD` | App password | — |
| `BSKY_HOST` | PDS host URL | `https://bsky.social` |
| `BSKY_BGS` | BGS host URL | `https://bsky.network` |
| `BSKY_PROFILE` | Profile name | — |
| `BSKY_CONFIG` | Path to config file | — |

### Example: CI pipeline

```bash
BSKY_HANDLE=bot.bsky.social BSKY_PASSWORD=my-app-password bsky post "Build passed!"
```

### Example: Docker

```bash
docker run --rm \
  -e BSKY_HANDLE=bot.bsky.social \
  -e BSKY_PASSWORD=my-app-password \
  bsky-cli post "Hello from Docker"
```

## Precedence

When the same setting is configured in multiple places, the highest-priority source wins:

1. **CLI arguments** (highest priority)
2. **Environment variables**
3. **Config file** (`config.toml`)
4. **Defaults** (lowest priority)

For example, if your config file sets `profile = "work"` but `BSKY_PROFILE=personal` is in the environment, the environment variable takes precedence. And if you pass `-p other` on the command line, that wins over both.

## Profiles

Profiles let you manage multiple Bluesky accounts from a single machine.

### Create profiles

```bash
bsky login alice.bsky.social -p personal
bsky login bob.bsky.social -p work
```

### Use a profile

```bash
bsky tl -p personal
bsky post "From work account" -p work
```

### Set a default profile

Instead of passing `-p` every time, set a default in your config file:

```toml
profile = "work"
```

Or use the environment variable:

```bash
export BSKY_PROFILE=work
bsky tl   # uses the "work" profile
```

### List profiles

```bash
bsky -p ? tl
```
