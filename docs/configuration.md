# Configuration

## Config file

Credentials and session data are stored in `~/.config/bsky/`. Each profile gets its own file.

The config directory is created automatically on first `bsky login`.

## Environment variables

All configuration can be set via environment variables. This is useful for CI pipelines, scripts, and Docker containers.

| Variable | Description | Default |
|----------|-------------|---------|
| `BSKY_HANDLE` | Bluesky handle | — |
| `BSKY_PASSWORD` | App password | — |
| `BSKY_HOST` | PDS host URL | `https://bsky.social` |
| `BSKY_BGS` | BGS host URL | `https://bsky.network` |
| `BSKY_PROFILE` | Profile name | — |

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
3. **Config file** (lowest priority)

For example, if `BSKY_HANDLE` is set in the environment but you also pass `-H alice.bsky.social` on the command line, the CLI argument takes precedence.

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

### List profiles

```bash
bsky -p ? tl
```

The `BSKY_PROFILE` environment variable can also set the default profile:

```bash
export BSKY_PROFILE=work
bsky tl   # uses the "work" profile
```
