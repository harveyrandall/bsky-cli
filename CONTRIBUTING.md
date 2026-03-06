# Contributing to bsky-cli

Thanks for your interest in contributing! This guide will help you get set up and explain how the project is organised.

## Prerequisites

- **Node.js** >= 22
- **Yarn 4** (Berry) — the repo includes a `.yarnrc.yml` that pins the version via Corepack
- **Git** with GPG signing configured (for maintainers)

## Getting Started

```bash
git clone https://github.com/harveyrandall/bsky-cli.git
cd bsky-cli
corepack enable          # activates the pinned Yarn version
yarn install             # install dependencies
yarn dev                 # run the CLI via tsx (no build step needed)
```

## Scripts

| Script | Description |
|--------|-------------|
| `yarn dev` | Run the CLI directly via tsx |
| `yarn build` | Build to `dist/` with tsup |
| `yarn typecheck` | Type-check with `tsc --noEmit` |
| `yarn test` | Run tests in watch mode |
| `yarn test:run` | Run tests once (CI) |
| `yarn test:coverage` | Run tests with coverage report |
| `yarn link:global` | Build and register `bsky` globally |
| `yarn unlink:global` | Remove the global symlink |

## Project Structure

```
src/
  commands/         # One file per command (+ co-located .test.ts)
    post.ts
    post.test.ts
    timeline.ts
    timeline.test.ts
    ...
  lib/              # Shared utilities
    format.ts       # Output formatting (printPost, outputJson, etc.)
    extract.ts      # Text and facet extraction
    types.ts        # Shared TypeScript types
  index.ts          # CLI entrypoint and Commander setup
  test-utils.ts     # Shared test helpers (mock agent, etc.)
```

Path aliases use `@/` to reference `src/` — configured in `tsconfig.json` and resolved by tsup at build time.

## Writing Code

- **TypeScript** — strict mode, no `any` unless absolutely necessary
- **ESM** — the project uses `"type": "module"` throughout
- **Formatting** — follow existing patterns; the codebase uses consistent 2-space indentation

## Writing Tests

Tests live alongside the source files they cover (e.g. `post.ts` → `post.test.ts`).

- Use **Vitest** for all tests
- Use the shared `createMockAgent()` helper from `@/test-utils` for mocking the AT Protocol agent
- Mock external modules with `vi.mock()` at the top of the file
- Use `vi.hoisted()` when mock values need to be available inside `vi.mock()` factories

Run the full suite before submitting:

```bash
yarn typecheck && yarn test:run
```

## Commit Conventions

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix | Use for |
|--------|---------|
| `feat:` | New features |
| `fix:` | Bug fixes |
| `refactor:` | Code changes that don't add features or fix bugs |
| `chore:` | Build, tooling, dependency updates |
| `test:` | Adding or updating tests |
| `docs:` | Documentation changes |

Examples:

```
feat: add --pattern-flags option to stream command
fix: resolve WebSocket reconnection on network timeout
chore: bump vitest to v4.1
docs: add shell completion examples to README
```

## Pull Requests

1. **Branch from `main`** — use a descriptive branch name (`feat/dm-support`, `fix/stream-cursor`)
2. **One feature per PR** — keep changes focused and reviewable
3. **Include tests** — new commands and options should have co-located test coverage
4. **Ensure CI passes** — `yarn typecheck && yarn test:run` must succeed
5. **Write a clear description** — explain what changed and why

## Reporting Issues

- Search existing issues before opening a new one
- Include your Node.js version, OS, and the command you ran
- Paste the full error output (use `--verbose` for extra detail)

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE.md).
