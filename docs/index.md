# bsky-cli

A command-line client for [Bluesky](https://bsky.app), built with TypeScript.

## Features

- **Full timeline access** — read your feed, stream the firehose with regex filtering, browse threads
- **Rich posting** — text, images, videos, replies, quotes, and deletions
- **Social graph** — follow, block, mute, and view followers/following
- **Bookmarks** — save and manage posts locally
- **Multi-account** — named profiles for switching between accounts
- **Shell completions** — bash, zsh, and fish
- **JSON output** — pipe everything into `jq`, scripts, or other tools

## Quick install

=== "npm"

    ```bash
    npm install -g bsky-cli
    ```

=== "Homebrew"

    ```bash
    brew install harveyrandall/bsky-cli
    ```

=== "Binary"

    Download a standalone binary from [GitHub Releases](https://github.com/harveyrandall/bsky-cli/releases).

=== "curl"

    ```bash
    curl -fsSL https://raw.githubusercontent.com/harveyrandall/bsky-cli/main/install.sh | sh
    ```

## First steps

```bash
# Log in
bsky login alice.bsky.social

# Read your timeline
bsky tl

# Post something
bsky post "Hello from the command line!"

# Stream the firehose, filtering for keywords
bsky stream --pattern "typescript|rust"
```

See the [Getting Started](getting-started.md) guide for a full walkthrough.
