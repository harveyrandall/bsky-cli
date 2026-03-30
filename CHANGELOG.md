# Changelog

All notable changes to this project will be documented in this file.

This changelog is generated from [Conventional Commits](https://www.conventionalcommits.org/).

## [1.9.1] — 2026-03-31

### Bug Fixes

- **dm:** resolve chat proxy ordering so handle-based commands work ([957556b](https://github.com/harveyrandall/bsky-cli/commit/957556b))
  - `configureProxy()` is agent-wide; `getProfile()` was routed through the chat service causing 501 errors
  - Handle resolution now runs before enabling the chat proxy
- **dm:** add graceful fallbacks for server-unimplemented chat methods ([957556b](https://github.com/harveyrandall/bsky-cli/commit/957556b))
  - `getConvoAvailability` → falls back to `getConvoForMembers`
  - `updateAllRead` → falls back to paginated `listConvos` + `updateRead`
  - `acceptConvo` → prints workaround guidance if not implemented
- **dm:** fix case-insensitive matching for "Method Not Implemented" errors

### Documentation

- generate full CHANGELOG.md from conventional commits ([98b4d18](https://github.com/harveyrandall/bsky-cli/commit/98b4d18))
- add Version Issues page to mkdocs and wiki ([b10917a](https://github.com/harveyrandall/bsky-cli/commit/b10917a))
- add DM upgrade notice banner to README ([fd43274](https://github.com/harveyrandall/bsky-cli/commit/fd43274))

## [1.9.0] — 2026-03-30

### Features

- **dm:** add direct message command with chat API support ([508c35a](https://github.com/harveyrandall/bsky-cli/commit/508c35a))

### Bug Fixes

- **dm:** resolve chat proxy ordering and add method fallbacks ([957556b](https://github.com/harveyrandall/bsky-cli/commit/957556b))
- **ci:** use yarn build with bun compile for binary releases ([0f1b170](https://github.com/harveyrandall/bsky-cli/commit/0f1b170))

### Documentation

- add DM command documentation and config defaults ([2a8a6ef](https://github.com/harveyrandall/bsky-cli/commit/2a8a6ef))

### Tests

- **dm:** add DM command tests ([f1a7cb5](https://github.com/harveyrandall/bsky-cli/commit/f1a7cb5))

## [1.8.7] — 2026-03-29

### Bug Fixes

- **ci:** use bun for build step in binary job ([5ffa074](https://github.com/harveyrandall/bsky-cli/commit/5ffa074))

## [1.8.6] — 2026-03-29

### Bug Fixes

- **ci:** run bun install before yarn build in release pipeline ([4c3f66b](https://github.com/harveyrandall/bsky-cli/commit/4c3f66b))

## [1.8.5] — 2026-03-29

### Bug Fixes

- add tslib as direct dependency for Windows PnP resolution ([b287ddc](https://github.com/harveyrandall/bsky-cli/commit/b287ddc))

## [1.8.4] — 2026-03-29

### Bug Fixes

- also bundle tslib (rrule dependency) for Windows builds ([aadc238](https://github.com/harveyrandall/bsky-cli/commit/aadc238))

## [1.8.3] — 2026-03-29

### Bug Fixes

- bundle rrule to resolve ESM/CJS dual-package conflict ([bf428e7](https://github.com/harveyrandall/bsky-cli/commit/bf428e7))
- **ci:** use yarn node for ESM smoke test ([f420df2](https://github.com/harveyrandall/bsky-cli/commit/f420df2))

### CI

- add Node ESM smoke test after build ([ca02b40](https://github.com/harveyrandall/bsky-cli/commit/ca02b40))

## [1.8.2] — 2026-03-29

### Bug Fixes

- use default import for rrule CJS module ([a9c7f22](https://github.com/harveyrandall/bsky-cli/commit/a9c7f22))

## [1.8.1] — 2026-03-29

### Features

- **config:** support BSKY_CONFIG env var for config file path ([351f88e](https://github.com/harveyrandall/bsky-cli/commit/351f88e))

## [1.8.0] — 2026-03-29

### Features

- **config:** add TOML config loader and applier ([9dd8d3c](https://github.com/harveyrandall/bsky-cli/commit/9dd8d3c))
- **config:** integrate config loading into CLI and add config command ([2b683cd](https://github.com/harveyrandall/bsky-cli/commit/2b683cd))
- **config:** add smol-toml dependency ([1d0a40b](https://github.com/harveyrandall/bsky-cli/commit/1d0a40b))

### Documentation

- add TOML config file documentation ([e325754](https://github.com/harveyrandall/bsky-cli/commit/e325754))

## [1.7.0] — 2026-03-28

### Features

- **schedule:** add schedule command with post, list, edit, delete, run ([3677067](https://github.com/harveyrandall/bsky-cli/commit/3677067))
- **schedule:** add cross-platform scheduler management module ([4e6e9bf](https://github.com/harveyrandall/bsky-cli/commit/4e6e9bf))
- **schedule:** add watch, enable, disable, status, uninstall subcommands ([1527a98](https://github.com/harveyrandall/bsky-cli/commit/1527a98))
- **schedule:** offer scheduler setup on first scheduled post ([bd5680f](https://github.com/harveyrandall/bsky-cli/commit/bd5680f))
- **schedule:** add recurrence module with RRULE generation and parsing ([0c8872a](https://github.com/harveyrandall/bsky-cli/commit/0c8872a))
- **schedule:** add --repeat option and recurring post handling ([11a6630](https://github.com/harveyrandall/bsky-cli/commit/11a6630))
- **schedule:** support editing recurrence in schedule edit ([7e07465](https://github.com/harveyrandall/bsky-cli/commit/7e07465))
- **schedule:** support infinite repeat (no --times = forever) ([0b4c1a2](https://github.com/harveyrandall/bsky-cli/commit/0b4c1a2))

### Bug Fixes

- **schedule:** address code review findings ([74e45f8](https://github.com/harveyrandall/bsky-cli/commit/74e45f8))
- **schedule:** address infinite repeat review findings ([3f8427c](https://github.com/harveyrandall/bsky-cli/commit/3f8427c))

### Documentation

- add schedule command documentation to README and mkdocs ([8dff01d](https://github.com/harveyrandall/bsky-cli/commit/8dff01d))

## [1.6.2] — 2026-03-27

### Bug Fixes

- **config:** resolve -p flag by handle when profile-named session file not found ([09a1afc](https://github.com/harveyrandall/bsky-cli/commit/09a1afc))

## [1.6.1] — 2026-03-27

### Refactoring

- **cli:** print correct version number from package.json & add '-V|--version' options ([85b3920](https://github.com/harveyrandall/bsky-cli/commit/85b3920))

## [1.6.0] — 2026-03-27

### Features

- **security:** add OS keychain credential store with filesystem fallback ([2561beb](https://github.com/harveyrandall/bsky-cli/commit/2561beb))

### Bug Fixes

- **login:** authenticate immediately, never persist password to disk ([14a715a](https://github.com/harveyrandall/bsky-cli/commit/14a715a))
- **auth:** use raw mode for truly hidden password input ([ea40a64](https://github.com/harveyrandall/bsky-cli/commit/ea40a64))

### Refactoring

- **config:** platform-aware config dirs, session-only storage ([e18ce9b](https://github.com/harveyrandall/bsky-cli/commit/e18ce9b))
- **client:** use SessionConfig, remove password-based login ([c61a966](https://github.com/harveyrandall/bsky-cli/commit/c61a966))
- **index:** wire up loadSessionConfig + env-var fallback for CI ([07ef3cc](https://github.com/harveyrandall/bsky-cli/commit/07ef3cc))

## [1.5.0] — 2026-03-26

### Features

- **engagement:** add unlike and remove-repost commands ([#5](https://github.com/harveyrandall/bsky-cli/pull/5))

## [1.4.0] — 2026-03-25

### Features

- **thread:** add manual split markers to create-thread ([#4](https://github.com/harveyrandall/bsky-cli/pull/4))

## [1.3.0] — 2026-03-24

### Features

- **thread:** add create-thread command with text splitting, validation, and draft support

## [1.2.0] — 2026-03-23

### Features

- **drafts:** add drafts subcommand group with offline sync, --draft flag, and SIGINT auto-save

## [1.1.0] — 2026-03-22

### Bug Fixes

- use fully qualified Homebrew formula name

## [1.0.1] — 2026-03-21

### Bug Fixes

- initial patch release

## [1.0.0] — 2026-03-21

### Features

- initial release with timeline, post, reply, quote, thread, search, profile, notifications, bookmarks, social commands, moderation, and app passwords
