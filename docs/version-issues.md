# Version Issues

Known issues by version and the fixes applied. If you encounter any of these problems, upgrade to the latest release.

## v1.9.0 — DM Chat Proxy Ordering

### Problem

`bsky dm read <handle>` and `bsky dm send <handle>` failed with **"Method Not Implemented"** (HTTP 501) when given a Bluesky handle.

### Root Cause

The AT Protocol chat API requires routing requests through `did:web:api.bsky.chat` via `agent.configureProxy()`. However, `configureProxy()` is **agent-wide** — it sets the `atproto-proxy` header on *all* subsequent HTTP requests, not just chat ones.

When a DM command needed to resolve a handle to a DID (e.g., `alice.bsky.social` → `did:plc:abc123`), it called `agent.getProfile()` **after** the proxy was configured. This routed the profile lookup through the chat service instead of the PDS, and the chat service returned 501 because it doesn't implement `app.bsky.actor.getProfile`.

```
❌ Before (broken):
  getClient() → configureProxy() → getProfile() [routed to chat → 501]

✅ After (fixed):
  getClient() → getProfile() [routed to PDS → success] → enableChatProxy()
```

### Fix

Restructured all handle-accepting DM commands to resolve handles **before** enabling the chat proxy. The `getChatClient()` helper was replaced with explicit `getClient()` + `enableChatProxy(agent)` calls, making the proxy mutation visible and ordering-safe.

**Fixed in:** v1.9.1

---

## v1.9.0 — Server-Unimplemented Chat Methods

### Problem

Some chat API methods defined in the AT Protocol lexicon are not yet implemented on the `api.bsky.chat` server, causing 501 errors at runtime even though the SDK provides client stubs for them.

### Affected Methods

| Method | Status | Fallback |
|--------|--------|----------|
| `getConvoAvailability` | Not implemented | Falls back to `getConvoForMembers` |
| `updateAllRead` | Implemented (works) | Fallback ready: paginated `listConvos` + `updateRead` |
| `acceptConvo` | Implemented (works) | Fallback ready: error with guidance to send a message |

### Root Cause

The `@atproto/api` SDK auto-generates client methods from lexicon schemas. A method existing in the SDK does not guarantee the server has deployed it. The `getConvoAvailability` endpoint is defined in the lexicon but returns 501 from `api.bsky.chat` as of March 2026.

### Fix

Added an `isNotImplemented()` helper that detects 501 responses (checking both `err.status` and case-insensitive message matching). Each potentially-unimplemented method is wrapped in a try/catch with a graceful fallback:

- **`getConvoAvailability`** → `getConvoForMembers` (creates a conversation if none exists — a minor side effect)
- **`updateAllRead`** → paginated `listConvos({ readState: "unread" })` + per-convo `updateRead`
- **`acceptConvo`** → prints guidance to send a message (which implicitly accepts)

**Fixed in:** v1.9.1

---

## v1.8.2–1.8.7 — rrule ESM/CJS Dual-Package Conflict

### Problem

`bsky help` (or any command) crashed on **Node.js 22** with:

```
SyntaxError: Named export 'RRule' not found.
The requested module 'rrule' is a CommonJS module.
```

### Root Cause

The `rrule` package ships both ESM and CJS entry points. Node.js resolved the CJS entry at runtime, but the source code used ESM named imports (`import { RRule } from "rrule"`). CJS modules don't support named exports in ESM — only a default export is available.

Neither TypeScript's type checker (`tsc`) nor the test runner (`vitest`) caught this because:

- `tsc` validates types against `.d.ts` files, not runtime module resolution
- `vitest` uses its own module loader which handles CJS/ESM interop transparently
- Only the **built output** running under Node's native ESM loader triggered the error

### Fix Timeline

| Version | Attempt | Result |
|---------|---------|--------|
| v1.8.2 | Switch to default import (`import rrulePkg from "rrule"`) | Fixed Node, broke Bun (Bun resolves ESM entry, no default export) |
| v1.8.3 | Bundle rrule into dist via `noExternal: ["rrule"]` in tsup | Fixed both, but tslib (rrule dep) failed on Windows PnP |
| v1.8.4 | Also bundle tslib via `noExternal: ["rrule", "tslib"]` | Still failed — esbuild can't read Yarn PnP zip archives |
| v1.8.5 | Add tslib as direct dependency | Didn't help — PnP zips are the issue |
| v1.8.6–1.8.7 | Various CI pipeline fixes | Tried `bun install` (real node_modules), broke rollup native binaries |
| v1.9.0 | `yarn unplug rrule tslib` in release workflow | Extracts from PnP zips to disk; esbuild resolves correctly |

### Final Fix

1. Source uses clean named imports: `import { RRule } from "rrule"`
2. tsup bundles rrule + tslib into the output: `noExternal: ["rrule", "tslib"]`
3. Release workflow runs `yarn unplug rrule tslib` before building
4. CI smoke test (`yarn node dist/index.js --help`) catches this class of bug

**Fully resolved in:** v1.9.0

---

## v1.5.0 and Earlier — Plaintext Credential Storage

### Problem

Credentials were stored in plaintext in the config file.

### Fix

v1.6.0 introduced OS keychain credential storage with a filesystem fallback. Passwords are never persisted to disk. If you used v1.5.0 or earlier, change your Bluesky app password after upgrading.

**Fixed in:** v1.6.0
