# Getting Started

## Prerequisites

- **Node.js >= 22** (for npm/yarn/pnpm/bun install methods)
- A [Bluesky](https://bsky.app) account

## Installation

=== "npm"

    ```bash
    npm install -g @harveyrandall/bsky-cli
    ```

=== "yarn"

    ```bash
    yarn global add @harveyrandall/bsky-cli
    ```

=== "pnpm"

    ```bash
    pnpm add -g @harveyrandall/bsky-cli
    ```

=== "bun"

    ```bash
    bun add -g @harveyrandall/bsky-cli
    ```

=== "Homebrew"

    ```bash
    brew install harveyrandall/tools/bsky-cli
    ```

=== "curl"

    ```bash
    curl -fsSL https://raw.githubusercontent.com/harveyrandall/bsky-cli/main/install.sh | sh
    ```

=== "Binary"

    Download a standalone binary for your platform from
    [GitHub Releases](https://github.com/harveyrandall/bsky-cli/releases),
    extract it, and move `bsky` to a directory on your `PATH`.

Verify the installation:

```bash
bsky --version
```

## Authentication

### Log in with an app password

!!! tip
    Use an [app password](https://bsky.app/settings/app-passwords) instead of your main password. App passwords can be revoked individually and don't grant full account access.

```bash
bsky login alice.bsky.social
# Enter your app password at the prompt (input is hidden)
```

Or pass the password directly:

```bash
bsky login alice.bsky.social my-app-password
```

### Your first commands

Read your timeline:

```bash
bsky tl
```

Post a message:

```bash
bsky post "Hello from bsky-cli!"
```

View your profile:

```bash
bsky profile
```

Search for posts:

```bash
bsky search "bluesky cli"
```

### JSON output

Every command supports `--json` for structured output:

```bash
bsky tl --json | jq '.[0].post.record.text'
```

### Multiple accounts

Use named profiles to switch between accounts:

```bash
bsky login alice.bsky.social -p personal
bsky login bob.bsky.social -p work

bsky tl -p personal
bsky tl -p work
```

List all profiles:

```bash
bsky -p ? tl
```

## Next steps

- Browse the full [command reference](commands.md)
- Set up [environment variables](configuration.md) for CI/scripts
- Install [shell completions](completions.md) for tab completion
