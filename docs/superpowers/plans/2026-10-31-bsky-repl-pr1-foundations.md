# `bsky repl` PR 1 (Foundations) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `bsky repl` opens an Ink composer with a segment-aware character ring, runs `/help` and `/exit`, and exits with the terminal fully restored, on Node and on the Bun-compiled binary (issue #20).

**Architecture:** A Commander `repl` command lazily imports `src/repl/`, so Ink and React load only for the REPL. Pure TypeScript in `src/repl/core/` (markers, tokenizer, dispatcher) and pure UI state in `src/repl/ui/editor.ts` / `keys.ts` hold the logic and the unit tests; Ink components only render and route input. Ink 8 enables and restores bracketed paste (`usePaste`) and the kitty keyboard protocol (`kittyKeyboard` render option, `signal-exit`) itself, so `terminal.ts` only probes whether the terminal supports kitty.

**Tech Stack:** TypeScript 5.9, Ink 8, React 19.3, Commander 14, Vitest 4, ink-testing-library 4, tsup 8 (ESM with code splitting), Yarn 4 (PnP), Bun (release binaries only).

**Spec:** `docs/superpowers/specs/2026-10-31-bsky-repl-design.md`, §3, §4, §6, §14, §16, §17 (PR 1 row) and §18.

## Where this plan departs from the spec

Ink 8 settles several PR 1 details that the spec left to a spike. Each departure is deliberate:

| Spec | This plan | Why |
|---|---|---|
| `ui/terminal.ts` enables and restores bracketed paste and kitty, with its own exit hooks | Ink does both: `usePaste` turns bracketed paste on while active; `render(…, { kittyKeyboard: { mode } })` enables kitty; Ink's `signal-exit` handler unmounts and restores both on exit, crash, `SIGTERM` and `SIGHUP`. `terminal.ts` only probes support. | Less code, and Ink's restore path already covers every exit route. |
| Kitty query timeout ~100 ms | The probe sends `ESC[?u` then DA1 (`ESC[c`) and resolves when the DA1 reply arrives; the 500 ms cap applies only to terminals that answer nothing | Every terminal answers DA1, so the usual wait is one round trip, and late reply bytes never leak into the composer. |
| PR 1 adds `@inkjs/ui` | Added in PR 3 with its first user (`NewMenu`) | No unused dependency. |
| PR 1 spike on Ink parsing paste and kitty sequences | Settled by reading Ink 8: pasted text arrives on `usePaste`'s own channel; `ESC[13;2u` parses as `return`+`shift`; `ESC\r` as `return`+`meta`; Ctrl+J as input `"\n"` (or `ctrl` + `"j"` under kitty). Task 6 tests pin this; Task 9's manual matrix confirms it on real terminals and Bun. | |
| Amber ring colour | Ink colour `"yellow"` | Terminals have no amber; yellow follows the user's theme. |
| Idle plain text shows a hint | PR 1 hint: `Posting from the REPL isn't available yet — /help lists commands.` | `/thread` and `/post` arrive in PR 2, which replaces this copy. |
| One client at REPL start | No client in PR 1 | Nothing in PR 1 talks to the network; `getClient` arrives with posting in PR 2. |
| `completions.ts`: add `repl` | No change | Completions are generated from `program.commands`, so `repl` and its flags appear automatically (checked in Task 8). |
| Release smoke on each Bun binary | Runs on the three binaries whose target matches the runner (`darwin-arm64`, `linux-x64`, `windows-x64`) | `darwin-x64` and `linux-arm64` are cross-compiled and can't run on their runners; the embedded JS is identical. |

`Ctrl+G` / `/edit` stay in PR 3 per §17; they will use Ink's `useApp().suspendTerminal()`.

## Global Constraints

- Node ≥ 22 (`engines`, and Ink 8's own `engines`). This Mac's default `node` is v18.20.8: run `nvm use` (`.nvmrc` is `22`) or prefix commands with `PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"`.
- Yarn 4 only (`yarn add`, `yarn test:run`); never `npm install`.
- New dependencies: `ink@^8`, `react@^19.3`; dev: `@types/react@^19.3`, `ink-testing-library@^4`. Nothing else.
- `src/repl/core/` never imports `ink` or `react`. Ink components hold no business logic.
- Only `src/commands/repl.ts` loads the UI, via `await import("@/repl")`. Nothing else imports `@/repl` or `@/repl/ui/*` statically (tests excepted). `src/commands/repl.ts` may import `@/repl/core/*`.
- Bun stays; the REPL must start on `node dist/index.js` and on the Bun-compiled binary.
- `repl` is not the default command yet (`isDefault` lands in PR 2).
- Exact copy: prompt `bsky ›`; kitty hint `This terminal can't tell Shift+Enter from Enter — use Alt+Enter or Ctrl+J for new lines.`; unknown command `Unknown /<name>. Did you mean /<suggestion>?`, or `Unknown /<name>. /help lists commands.` when nothing is close; over-limit count `342/300 (−42)` with U+2212 MINUS SIGN.
- Ring (limit 300): glyph by share `○` < 20 %, `◔` < 50 %, `◑` < 75 %, `◕` < 100 %, `●` ≥ 100 %; colour green below `limit − 40` (260), yellow from 260 to 300, red above 300.
- Default markers: split `///`, send `//>`, cut `<//`; config keys `split-marker`, `send-marker`, `cut-marker`.
- Commits are GPG-signed (repo default); never pass `--no-gpg-sign`. Prefixes: `feat(repl):`, `ci:`, `docs(repl):`.

## Review Focus

1. Pasted or unbracketed input with Windows line endings (`\r\n`, lone `\r`) should be stored as `\n`, so counts and rendering stay right. Tests: Task 5 `insert` normalisation; Task 6 paste test uses `\r\n`.
2. A terminal that answers the probe slowly or not at all (SSH, tmux, old consoles) should delay startup by at most 500 ms, and reply bytes should never land in the composer. Tests: Task 7 "resolves on DA1 before any timer fires" and "times out at 500 ms".
3. Bad `[repl]` marker values (empty, whitespace, duplicate, non-string) should stop startup with an error naming the key and value, never hang `scanMarkers`. Test: Task 1 `resolveMarkers` cases.
4. Unclosed quotes in a slash command should print one error line, keep the text and keep the REPL running. Test: Task 2 `dispatch('/help "exit')`.
5. `bsky repl | tee log` (stdin a TTY, stdout piped) should print help on stderr and exit 1, never draw half a UI. Test: Task 4 `it.each` over non-TTY stdin and stdout.

---

### Task 1: Markers and segments

**Files:**
- Create: `src/repl/core/markers.ts`
- Test: `src/repl/core/markers.test.ts`

**Interfaces:**
- Produces (PR 2 builds `parseMarkers()` for submit on `scanMarkers`):

```ts
export interface Markers { split: string; send: string; cut: string }
export const DEFAULT_MARKERS: Markers; // { split: "///", send: "//>", cut: "<//" }
export function resolveMarkers(opts: { splitMarker?: unknown; sendMarker?: unknown; cutMarker?: unknown }): Markers;
export interface MarkerHit { kind: "split" | "send" | "cut"; start: number; end: number } // UTF-16 offsets
export function scanMarkers(text: string, m: Markers): MarkerHit[];
export interface Segment { index: number; total: number; text: string; region: "send" | "kept" | "cut" }
export function segmentAt(text: string, cursor: number, m: Markers): Segment;
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { DEFAULT_MARKERS as m, resolveMarkers, scanMarkers, segmentAt } from "./markers";

describe("scanMarkers", () => {
  it("finds each marker kind with offsets", () => {
    expect(scanMarkers("a /// b //> c <// d", m)).toEqual([
      { kind: "split", start: 2, end: 5 },
      { kind: "send", start: 8, end: 11 },
      { kind: "cut", start: 14, end: 17 },
    ]);
  });
  it("ignores escaped markers", () => {
    expect(scanMarkers("file:\\///tmp", m)).toEqual([]);
  });
  it("prefers the longest marker at a position", () => {
    expect(scanMarkers("a ///b", { split: "//", send: "///", cut: "<<" })).toEqual([
      { kind: "send", start: 2, end: 5 },
    ]);
  });
});

describe("segmentAt", () => {
  it("treats unmarked text as one segment", () => {
    expect(segmentAt("hello", 5, m)).toEqual({ index: 1, total: 1, text: "hello", region: "send" });
  });
  it("returns the trimmed segment under the cursor", () => {
    expect(segmentAt("one /// two /// three", 9, m)).toEqual({ index: 2, total: 3, text: "two", region: "send" });
  });
  it("puts a cursor right after a marker in the next segment", () => {
    expect(segmentAt("one ///", 7, m)).toEqual({ index: 2, total: 2, text: "", region: "send" });
  });
  it("removes escapes before counting", () => {
    expect(segmentAt("file:\\///tmp", 0, m).text).toBe("file:///tmp");
  });
  it("marks text after //> as kept", () => {
    expect(segmentAt("now //> later", 12, m)).toMatchObject({ region: "kept", text: "later" });
  });
  it("marks text after <// in the send part as cut", () => {
    expect(segmentAt("post <// scrap //> later", 11, m)).toMatchObject({ region: "cut", text: "scrap" });
  });
  it("counts only send pieces", () => {
    expect(segmentAt("a /// b <// c", 0, m)).toEqual({ index: 1, total: 2, text: "a", region: "send" });
  });
});

describe("resolveMarkers", () => {
  it("defaults and overrides", () => {
    expect(resolveMarkers({})).toEqual(m);
    expect(resolveMarkers({ splitMarker: "~~" })).toEqual({ ...m, split: "~~" });
  });
  it.each([
    [{ splitMarker: "" }, 'Invalid [repl] split-marker = ""'],
    [{ sendMarker: "a b" }, 'Invalid [repl] send-marker = "a b"'],
    [{ cutMarker: 5 }, "Invalid [repl] cut-marker = 5"],
    [{ cutMarker: "///" }, 'Invalid [repl] cut-marker = "///"'],
  ])("rejects %o", (opts, message) => {
    expect(() => resolveMarkers(opts)).toThrow(message);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `yarn vitest run src/repl/core/markers.test.ts`
Expected: FAIL, cannot resolve `./markers`.

- [ ] **Step 3: Implement `src/repl/core/markers.ts`**

- `scanMarkers`: walk left to right. At `i`, if `text[i] === "\\"` and a marker starts at `i + 1`, jump past that marker without recording a hit. Otherwise, if a marker starts at `i` (try the longest marker first), record it and jump to its end. Otherwise `i++`.
- `segmentAt`, regions per spec §7: everything after the first `send` hit is `kept`; within the send part, everything from the first `cut` hit up to the send hit is `cut`; the rest splits at `split` hits into pieces numbered from 1. A cursor at a hit's `end` belongs to the following piece; at its `start` or inside it, to the preceding one. `text` is the cursor's piece or region with escapes removed (`\` directly before a marker) and trimmed. `total` counts send pieces, empty ones included, so a trailing `///` reads as the next segment. In kept/cut regions `index` is `0`.
- `resolveMarkers`: `undefined` takes the default. Otherwise each value must be a non-empty string with no whitespace, and all three must differ. On failure throw `Invalid [repl] ${key} = ${JSON.stringify(value)}: markers must be non-empty, have no spaces, and differ from each other`, with `key` being `split-marker`, `send-marker` or `cut-marker`. For a duplicate, name the later key in split → send → cut order.

- [ ] **Step 4: Run them to verify they pass**

Run: `yarn vitest run src/repl/core/markers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/repl/core/markers.ts src/repl/core/markers.test.ts
git commit -m "feat(repl): scan split/send/cut markers and find the segment under the cursor"
```

### Task 2: Tokenizer, command registry and dispatcher

**Files:**
- Create: `src/repl/core/commands.ts`, `src/repl/core/dispatch.ts`
- Test: `src/repl/core/commands.test.ts`, `src/repl/core/dispatch.test.ts`

**Interfaces:**
- Produces:

```ts
// commands.ts
export type LineStyle = "normal" | "dim" | "error";
export interface CommandContext { print(text: string, style?: LineStyle): void; exit(): void }
export interface ReplCommand {
  name: string; aliases: string[]; usage: string; summary: string;
  run(args: string[], ctx: CommandContext): void | Promise<void>;
}
export const COMMANDS: readonly ReplCommand[];      // help, exit (alias quit)
export function findCommand(name: string): ReplCommand | undefined;
export function tokenize(input: string): string[];
export function suggest(name: string, candidates: readonly string[]): string | undefined;
export function unknownMessage(name: string): string;
export function completeCommand(text: string, cursor: number): { text: string; cursor: number; candidates: string[] };
// dispatch.ts
export const TEXT_HINT = "Posting from the REPL isn't available yet — /help lists commands.";
export type Parsed = { kind: "empty" } | { kind: "text"; text: string } | { kind: "command"; name: string; rest: string };
export function parseInput(input: string): Parsed;
export type DispatchResult = "done" | "keep";        // "keep" = leave the text in the composer
export function dispatch(input: string, ctx: CommandContext): Promise<DispatchResult>;
```

- [ ] **Step 1: Write the failing tests**

`commands.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { tokenize, suggest, completeCommand } from "./commands";

describe("tokenize", () => {
  it("splits like a shell", () => {
    expect(tokenize(`a "b c" 'd e' f\\ g`)).toEqual(["a", "b c", "d e", "f g"]);
    expect(tokenize(`"say \\"hi\\""`)).toEqual([`say "hi"`]);
    expect(tokenize(`'no \\escape'`)).toEqual(["no \\escape"]);
    expect(tokenize(`a"b c"`)).toEqual(["ab c"]);
    expect(tokenize("  spaced   out  ")).toEqual(["spaced", "out"]);
    expect(tokenize(`""`)).toEqual([""]);
    expect(tokenize("trailing\\")).toEqual(["trailing\\"]);
  });
  it("rejects an unclosed quote", () => {
    expect(() => tokenize(`"open`)).toThrow("Unclosed quote");
  });
});

describe("suggest", () => {
  it("finds the closest name within distance 2", () => {
    expect(suggest("hlp", ["exit", "help", "quit"])).toBe("help");
    expect(suggest("zzzzz", ["exit", "help", "quit"])).toBeUndefined();
  });
});

describe("completeCommand", () => {
  it("completes a unique command name", () => {
    expect(completeCommand("/he", 3)).toEqual({ text: "/help ", cursor: 6, candidates: [] });
    expect(completeCommand("/e", 2)).toEqual({ text: "/exit ", cursor: 6, candidates: [] });
  });
  it("lists candidates when it can't extend", () => {
    expect(completeCommand("/", 1)).toEqual({ text: "/", cursor: 1, candidates: ["exit", "help", "quit"] });
  });
  it("leaves other text alone", () => {
    expect(completeCommand("/x", 2)).toEqual({ text: "/x", cursor: 2, candidates: [] });
    expect(completeCommand("hello", 5)).toEqual({ text: "hello", cursor: 5, candidates: [] });
    expect(completeCommand("/help ex", 8)).toEqual({ text: "/help ex", cursor: 8, candidates: [] });
  });
});
```

`dispatch.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { dispatch, parseInput, TEXT_HINT } from "./dispatch";

const ctx = () => ({ print: vi.fn(), exit: vi.fn() });
const printed = (c: ReturnType<typeof ctx>) => c.print.mock.calls.map((call) => call[0]).join("\n");

describe("parseInput", () => {
  it("classifies input", () => {
    expect(parseInput("   ")).toEqual({ kind: "empty" });
    expect(parseInput("/help exit")).toEqual({ kind: "command", name: "help", rest: "exit" });
    expect(parseInput("/Help")).toEqual({ kind: "text", text: "/Help" });
    expect(parseInput("\\/tmp is a path")).toEqual({ kind: "text", text: "/tmp is a path" });
    expect(parseInput("//> keep")).toEqual({ kind: "text", text: "//> keep" });
  });
});

describe("dispatch", () => {
  it("/exit and /quit exit", async () => {
    for (const input of ["/exit", "/quit"]) {
      const c = ctx();
      expect(await dispatch(input, c)).toBe("done");
      expect(c.exit).toHaveBeenCalledOnce();
    }
  });
  it("/help lists every command", async () => {
    const c = ctx();
    expect(await dispatch("/help", c)).toBe("done");
    expect(printed(c)).toContain("/help [command]");
    expect(printed(c)).toContain("/exit");
  });
  it("/help <cmd> shows usage and aliases", async () => {
    const c = ctx();
    await dispatch("/help exit", c);
    expect(printed(c)).toContain("Aliases: /quit");
  });
  it("suggests a close command and keeps the text", async () => {
    const c = ctx();
    expect(await dispatch("/hlp", c)).toBe("keep");
    expect(c.print).toHaveBeenCalledWith("Unknown /hlp. Did you mean /help?", "error");
  });
  it("points at /help when nothing is close", async () => {
    const c = ctx();
    expect(await dispatch("/zzzz", c)).toBe("keep");
    expect(c.print).toHaveBeenCalledWith("Unknown /zzzz. /help lists commands.", "error");
  });
  it("reports an unclosed quote and keeps the text", async () => {
    const c = ctx();
    expect(await dispatch('/help "exit', c)).toBe("keep");
    expect(c.print).toHaveBeenCalledWith("Unclosed quote", "error");
  });
  it("keeps plain text with a hint", async () => {
    const c = ctx();
    expect(await dispatch("hello", c)).toBe("keep");
    expect(c.print).toHaveBeenCalledWith(TEXT_HINT, "dim");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `yarn vitest run src/repl/core`
Expected: FAIL, cannot resolve `./commands` and `./dispatch`.

- [ ] **Step 3: Implement `commands.ts`**

- `tokenize`: whitespace separates tokens; `'…'` is literal; inside `"…"`, only `\"` and `\\` are escapes; outside quotes `\x` becomes `x`, and a lone trailing `\` stays; adjacent quoted and unquoted parts join into one token. An unterminated quote throws `Error("Unclosed quote")`.
- `COMMANDS`: `help` (usage `/help [command]`, summary `List commands, or show help for one`) and `exit` (aliases `["quit"]`, usage `/exit`, summary `Leave the REPL (same as Ctrl+D)`). `/help` with no args prints one plain line per command: `usage.padEnd(18) + summary`. `/help <name>` prints the usage, the summary and `Aliases: /quit` when there are any. An unknown name prints `unknownMessage(name)` as `"error"`. `exit.run` calls `ctx.exit()`.
- `suggest`: Levenshtein distance; the best candidate with distance ≤ 2; ties go to the first in sorted order.
- `unknownMessage(name)`: the two copy strings from Global Constraints, suggesting over all names and aliases.
- `completeCommand`: acts only when the whole text matches `^\/[a-z-]*$` and the cursor is at the end. Candidates are names and aliases starting with the typed prefix, sorted. One candidate gives `/<name> `; several extend to their longest common prefix, and `candidates` is returned only when no extension happened; none leaves the text unchanged.

- [ ] **Step 4: Implement `dispatch.ts`**

- `parseInput`: whitespace-only → `empty`. After `trimStart()`: a leading `\/` → `text` with that backslash removed; `^\/[a-z]` → `command` with `name` up to the first whitespace (without the `/`) and the rest trimmed; anything else → `text` (untrimmed).
- `dispatch`: `empty` → `"done"`. `text` → print `TEXT_HINT` as `"dim"`, `"keep"`. `command` → unknown name prints `unknownMessage` as `"error"` and returns `"keep"`; otherwise `tokenize(rest)` and `await cmd.run(args, ctx)` return `"done"`. Any thrown error prints its message as `"error"` and returns `"keep"`: the REPL never exits on an error (spec §11).

- [ ] **Step 5: Run them to verify they pass**

Run: `yarn vitest run src/repl/core`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/repl/core/commands.ts src/repl/core/commands.test.ts src/repl/core/dispatch.ts src/repl/core/dispatch.test.ts
git commit -m "feat(repl): add shell-style tokenizer, /help, /exit and the dispatcher"
```

### Task 3: Toolchain, App shell and smoke frame

**Files:**
- Modify: `package.json`, `yarn.lock` (via `yarn add`), `tsconfig.json`, `vitest.config.ts`
- Create: `src/repl/index.tsx`, `src/repl/ui/App.tsx`
- Test: `src/repl/index.test.tsx`

**Interfaces:**
- Consumes: `Markers`, `DEFAULT_MARKERS` (Task 1); `LineStyle` (Task 2).
- Produces:

```ts
// ui/App.tsx
export const HEADER = "bsky repl · /help for commands · Ctrl+D to exit";
export const KITTY_HINT = "This terminal can't tell Shift+Enter from Enter — use Alt+Enter or Ctrl+J for new lines.";
export interface AppProps { markers: Markers; kittyHint: boolean }
export function App(props: AppProps); // JSX
// index.tsx
export interface ReplOptions { markers: Markers }
export function startRepl(opts: ReplOptions): Promise<void>;
export function smokeFrame(): string;
```

- [ ] **Step 1: Add dependencies and JSX support**

```bash
yarn add ink@^8 react@^19.3
yarn add -D @types/react@^19.3 ink-testing-library@^4
```

In `tsconfig.json` `compilerOptions`, add `"jsx": "react-jsx"`. In `vitest.config.ts`, set `include: ["src/**/*.test.ts", "src/**/*.test.tsx"]`.

- [ ] **Step 2: Write the failing test**

```tsx
import { describe, it, expect } from "vitest";
import { renderToString } from "ink";
import { smokeFrame } from "@/repl";
import { App, HEADER, KITTY_HINT } from "@/repl/ui/App";
import { DEFAULT_MARKERS } from "@/repl/core/markers";

describe("App shell", () => {
  it("smokeFrame renders the header and prompt without a TTY", () => {
    const frame = smokeFrame();
    expect(frame).toContain(HEADER);
    expect(frame).toContain("bsky ›");
    expect(frame).not.toContain(KITTY_HINT);
  });
  it("shows the kitty hint when asked", () => {
    expect(renderToString(<App markers={DEFAULT_MARKERS} kittyHint />)).toContain(KITTY_HINT);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `yarn vitest run src/repl/index.test.tsx`
Expected: FAIL, cannot resolve `@/repl`.

- [ ] **Step 4: Implement the App shell and `index.tsx`**

`App` keeps `log: { id: number; text: string; style: LineStyle }[]` in state, seeded with `HEADER` and, when `kittyHint` is set, `KITTY_HINT` as `"dim"`. It renders `<Static items={log}>` (`dim` → `dimColor`, `error` → `color="red"`) and then `<Text>bsky › </Text>`, which Task 6 replaces with the Composer.
`startRepl` calls `render(<App markers={opts.markers} kittyHint={false} />, { exitOnCtrlC: false })` and awaits `waitUntilExit()`; Task 7 adds the kitty probe.
`smokeFrame` returns `renderToString(<App markers={DEFAULT_MARKERS} kittyHint={false} />)`.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `yarn typecheck && yarn test:run`
Expected: no type errors; every test passes, the existing suite included.

- [ ] **Step 6: Commit**

```bash
git add package.json yarn.lock tsconfig.json vitest.config.ts src/repl/index.tsx src/repl/index.test.tsx src/repl/ui/App.tsx
git commit -m "feat(repl): add Ink app shell and a smoke frame"
```

### Task 4: `bsky repl` command, flags and `[repl]` config

**Files:**
- Create: `src/commands/repl.ts`
- Modify: `src/index.ts` (import, then `registerRepl(program)` after `registerDm(program)`), `src/toml-config.ts` (`generateDefaultConfig()`), `src/toml-config.test.ts` (add `"[repl]"` to the section list), `docs/configuration.md` (the same block in "Full schema reference")
- Test: `src/commands/repl.test.ts`

**Interfaces:**
- Consumes: `resolveMarkers`, `DEFAULT_MARKERS` (Task 1); `startRepl`, `smokeFrame` (Task 3), through `await import("@/repl")` only.
- Produces: `registerRepl(program: Command): void`; `parseCooldown(value: string): number`.

Flags (spec §4); every option description is the text after the flag:

| Flag | Description |
|---|---|
| `-t, --auto-thread` | `Start a thread when you type plain text` |
| `--no-auto-thread` | `Don't start a thread from plain text` |
| `-l, --prefix-thread` | `Label posts per thread (A1, B2…)` |
| `--undo <seconds>` (parser `parseCooldown`) | `Undo window before each post: 0, 5, 10 or 15` |
| `--pace <seconds>` (parser `parseCooldown`) | `Minimum seconds between posts: 0, 5, 10 or 15` |
| `-f, --force-alt` | `Require alt text for media` |
| `--thread-label` | `Add 🧵 to posts in the active thread` |
| `--prepend-thread-label` | `Put the 🧵 first instead of last` |
| `-r, --resume [id]` | `Resume a saved session (id, prefix or "last")` |
| `--resumable` | `Save this session so it can be resumed (default)` |
| `-R, --no-resumable` | `Don't save this session` |

Command description: `Interactive REPL for writing threads`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerRepl } from "@/commands/repl";
import { applyConfigToProgram } from "@/toml-config";
import { DEFAULT_MARKERS } from "@/repl/core/markers";

const { startRepl, smokeFrame } = vi.hoisted(() => ({
  startRepl: vi.fn(),
  smokeFrame: vi.fn(() => "FRAME"),
}));
vi.mock("@/repl", () => ({ startRepl, smokeFrame }));

const original = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
function setTTY(stdin: boolean | undefined, stdout: boolean | undefined) {
  Object.defineProperty(process.stdin, "isTTY", { value: stdin, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: stdout, configurable: true });
}
function makeProgram(config: Record<string, unknown> = {}) {
  const program = new Command().exitOverride();
  registerRepl(program);
  applyConfigToProgram(program, config);
  return program;
}
const replOpts = (p: Command) => p.commands.find((c) => c.name() === "repl")!.opts();

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.BSKY_REPL_SMOKE;
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  setTTY(original.stdin, original.stdout);
  delete process.env.BSKY_REPL_SMOKE;
});

describe("bsky repl", () => {
  it("starts the REPL with default markers in a terminal", async () => {
    setTTY(true, true);
    await makeProgram().parseAsync(["repl"], { from: "user" });
    expect(startRepl).toHaveBeenCalledWith({ markers: DEFAULT_MARKERS });
  });

  it.each([[false, true], [true, false]])(
    "prints help to stderr and exits 1 when stdin.isTTY=%s, stdout.isTTY=%s",
    async (stdin, stdout) => {
      setTTY(stdin, stdout);
      await expect(makeProgram().parseAsync(["repl"], { from: "user" })).rejects.toMatchObject({ exitCode: 1 });
      expect(process.stderr.write).toHaveBeenCalled();
      expect(startRepl).not.toHaveBeenCalled();
    },
  );

  it("smoke mode renders one frame even without a TTY", async () => {
    setTTY(false, false);
    process.env.BSKY_REPL_SMOKE = "1";
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await makeProgram().parseAsync(["repl"], { from: "user" });
    expect(out).toHaveBeenCalledWith("FRAME\n");
    expect(startRepl).not.toHaveBeenCalled();
  });

  it("rejects --undo values other than 0, 5, 10 or 15", async () => {
    await expect(makeProgram().parseAsync(["repl", "--undo", "7"], { from: "user" })).rejects.toThrow(
      "must be 0, 5, 10 or 15",
    );
  });

  it("parses every flag", async () => {
    setTTY(true, true);
    const p = makeProgram();
    await p.parseAsync(
      ["repl", "-t", "-l", "--undo", "5", "--pace", "0", "-f", "--thread-label", "-r", "k3f9xq", "-R"],
      { from: "user" },
    );
    expect(replOpts(p)).toMatchObject({
      autoThread: true, prefixThread: true, undo: 5, pace: 0, forceAlt: true,
      threadLabel: true, resume: "k3f9xq", resumable: false,
    });
  });

  it("takes [repl] config values, and CLI flags win", async () => {
    setTTY(true, true);
    const p = makeProgram({ repl: { undo: 5, pace: 10, "split-marker": "~~" } });
    await p.parseAsync(["repl", "--pace", "15"], { from: "user" });
    expect(replOpts(p)).toMatchObject({ undo: 5, pace: 15 });
    expect(startRepl).toHaveBeenCalledWith({ markers: { ...DEFAULT_MARKERS, split: "~~" } });
  });

  it("stops with an error for a bad marker", async () => {
    setTTY(true, true);
    await expect(
      makeProgram({ repl: { "cut-marker": "" } }).parseAsync(["repl"], { from: "user" }),
    ).rejects.toThrow('Invalid [repl] cut-marker = ""');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `yarn vitest run src/commands/repl.test.ts`
Expected: FAIL, cannot resolve `@/commands/repl`.

- [ ] **Step 3: Implement `src/commands/repl.ts`**

`parseCooldown` returns `Number(value)` for `"0" | "5" | "10" | "15"` and otherwise throws `new InvalidArgumentError("must be 0, 5, 10 or 15")`. The action runs in this order (spec §4):
1. `process.env.BSKY_REPL_SMOKE === "1"`: `const { smokeFrame } = await import("@/repl")`, write `smokeFrame() + "\n"` to stdout, return.
2. `!process.stdin.isTTY || !process.stdout.isTTY`: `program.help({ error: true })` (stderr, exit 1).
3. `const markers = resolveMarkers(opts)`. A throw reaches `index.ts`'s catch, which prints the message and exits 1.
4. `const { startRepl } = await import("@/repl"); await startRepl({ markers });`

No other flag is read in PR 1. Undo, pace and the rest are wired so config and completions see them; their values are validated and used from PR 2 on.

- [ ] **Step 4: Register the command and add the `[repl]` config block**

In `src/index.ts`, import `registerRepl` and call it after `registerDm(program)`, before the TOML config is applied. In `generateDefaultConfig()`, insert after the `[create-thread]` block (and paste the same lines into `docs/configuration.md`):

```toml
[repl]
# auto-thread = false
# prefix-thread = false
# undo and pace: 0, 5, 10 or 15 seconds; leave unset to be asked
# undo = 5
# pace = 0
# force-alt = false
# thread-label = false
# prepend-thread-label = false
# ask-to-save = true
# resumable = true
# keep-sessions = 50
# split-marker = "///"
# send-marker = "//>"
# cut-marker = "<//"
```

Add `"[repl]"` to the `sections` list in `src/toml-config.test.ts`.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `yarn typecheck && yarn test:run`
Expected: no type errors; every test passes.

- [ ] **Step 6: Commit**

```bash
git add src/commands/repl.ts src/commands/repl.test.ts src/index.ts src/toml-config.ts src/toml-config.test.ts docs/configuration.md
git commit -m "feat(repl): add bsky repl command, flags and [repl] config"
```

### Task 5: Editor state and key mapping

**Files:**
- Create: `src/repl/ui/editor.ts`, `src/repl/ui/keys.ts`
- Test: `src/repl/ui/editor.test.ts`, `src/repl/ui/keys.test.ts`

**Interfaces:**
- Produces:

```ts
// editor.ts
export interface EditorState { text: string; cursor: number; history: string[]; historyIndex: number | null; draft: string }
export function emptyEditor(history?: string[]): EditorState;
export type EditorAction =
  | { type: "insert"; text: string } | { type: "set"; text: string }
  | { type: "newline" } | { type: "continueLine" } | { type: "backspace" } | { type: "delete" }
  | { type: "left" } | { type: "right" } | { type: "up" } | { type: "down" }
  | { type: "lineStart" } | { type: "lineEnd" } | { type: "wordLeft" } | { type: "wordRight" }
  | { type: "deleteWord" } | { type: "deleteToLineStart" } | { type: "clear" } | { type: "submitted" };
export function editorReducer(s: EditorState, a: EditorAction): EditorState;
// keys.ts
export type KeyAction = EditorAction
  | { type: "submit" } | { type: "complete" } | { type: "interrupt" } | { type: "eof" } | { type: "ignore" };
export function keyToAction(input: string, key: Key, s: { text: string; cursor: number }): KeyAction; // Key from "ink"
```

- [ ] **Step 1: Write the failing tests**

`editor.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { editorReducer as r, emptyEditor } from "./editor";

const at = (text: string, cursor = text.length) => ({ ...emptyEditor(), text, cursor });

describe("editorReducer", () => {
  it("inserts at the cursor and normalises CR and CRLF", () => {
    expect(r(at("ac", 1), { type: "insert", text: "b" })).toMatchObject({ text: "abc", cursor: 2 });
    expect(r(at(""), { type: "insert", text: "a\r\nb\rc" })).toMatchObject({ text: "a\nb\nc", cursor: 5 });
  });
  it("moves and deletes by whole graphemes", () => {
    expect(r(at("a👍🏽"), { type: "backspace" })).toMatchObject({ text: "a", cursor: 1 });
    expect(r(at("👨‍👩‍👧b", 0), { type: "delete" })).toMatchObject({ text: "b", cursor: 0 });
    expect(r(at("a👍🏽"), { type: "left" }).cursor).toBe(1);
  });
  it("replaces a trailing backslash with a newline", () => {
    expect(r(at("a\\"), { type: "continueLine" })).toMatchObject({ text: "a\n", cursor: 2 });
  });
  it("jumps and deletes by words", () => {
    expect(r(at("one two  three"), { type: "wordLeft" }).cursor).toBe(9);
    expect(r(at("one two", 0), { type: "wordRight" }).cursor).toBe(3);
    expect(r(at("one two  "), { type: "deleteWord" })).toMatchObject({ text: "one ", cursor: 4 });
    expect(r(at("x\nabc def", 6), { type: "deleteToLineStart" })).toMatchObject({ text: "x\ndef", cursor: 2 });
  });
  it("works within the current line", () => {
    expect(r(at("ab\ncd", 4), { type: "lineStart" }).cursor).toBe(3);
    expect(r(at("ab\ncd", 0), { type: "lineEnd" }).cursor).toBe(2);
  });
  it("moves between lines, keeping the column", () => {
    expect(r(at("abc\nde", 6), { type: "up" }).cursor).toBe(2);
    expect(r(at("abc\nde", 3), { type: "down" }).cursor).toBe(6);
  });
  it("walks history from the first and last lines and restores the draft", () => {
    let s = { ...emptyEditor(["first", "second"]), text: "draft", cursor: 5 };
    s = r(s, { type: "up" }); expect(s.text).toBe("second");
    s = r(s, { type: "up" }); expect(s.text).toBe("first");
    s = r(s, { type: "up" }); expect(s.text).toBe("first");
    s = r(s, { type: "down" }); expect(s.text).toBe("second");
    s = r(s, { type: "down" }); expect(s).toMatchObject({ text: "draft", cursor: 5 });
  });
  it("submitted records history and clears", () => {
    expect(r(at("/help"), { type: "submitted" })).toMatchObject({ text: "", cursor: 0, history: ["/help"] });
  });
});
```

`keys.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Key } from "ink";
import { keyToAction } from "./keys";

const key = (k: Partial<Key> = {}): Key => ({
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
  home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false,
  backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false,
  ...k,
});
const s = (text: string, cursor = text.length) => ({ text, cursor });

describe("keyToAction", () => {
  it.each([
    ["Enter", "\r", key({ return: true }), s("hi"), { type: "submit" }],
    ["Shift+Enter (kitty)", "\r", key({ return: true, shift: true }), s("hi"), { type: "newline" }],
    ["Alt+Enter", "", key({ return: true, meta: true }), s("hi"), { type: "newline" }],
    ["Ctrl+J", "\n", key(), s("hi"), { type: "newline" }],
    ["Ctrl+J (kitty)", "j", key({ ctrl: true }), s("hi"), { type: "newline" }],
    ["trailing \\ + Enter", "\r", key({ return: true }), s("hi\\"), { type: "continueLine" }],
    ["\\ mid-line + Enter", "\r", key({ return: true }), s("a\\b", 2), { type: "submit" }],
    ["Tab", "", key({ tab: true }), s("/he"), { type: "complete" }],
    ["Ctrl+C", "c", key({ ctrl: true }), s(""), { type: "interrupt" }],
    ["Ctrl+D", "d", key({ ctrl: true }), s(""), { type: "eof" }],
    ["Ctrl+A", "a", key({ ctrl: true }), s("x"), { type: "lineStart" }],
    ["Ctrl+E", "e", key({ ctrl: true }), s("x"), { type: "lineEnd" }],
    ["Ctrl+W", "w", key({ ctrl: true }), s("x"), { type: "deleteWord" }],
    ["Ctrl+U", "u", key({ ctrl: true }), s("x"), { type: "deleteToLineStart" }],
    ["Alt+B", "b", key({ meta: true }), s("x"), { type: "wordLeft" }],
    ["Alt+←", "", key({ meta: true, leftArrow: true }), s("x"), { type: "wordLeft" }],
    ["Alt+F", "f", key({ meta: true }), s("x"), { type: "wordRight" }],
    ["Backspace", "", key({ backspace: true }), s("x"), { type: "backspace" }],
    ["Delete", "", key({ delete: true }), s("x"), { type: "delete" }],
    ["Esc", "", key({ escape: true }), s("x"), { type: "ignore" }],
    ["unbound Ctrl", "x", key({ ctrl: true }), s("x"), { type: "ignore" }],
    ["text", "hé", key(), s(""), { type: "insert", text: "hé" }],
  ])("%s", (_name, input, k, state, action) => {
    expect(keyToAction(input, k, state)).toEqual(action);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `yarn vitest run src/repl/ui/editor.test.ts src/repl/ui/keys.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `editor.ts`**

- `cursor` is a UTF-16 offset that always sits on a grapheme boundary; `left`, `right`, `backspace` and `delete` step one grapheme (`Intl.Segmenter`, as in `src/lib/split-thread.ts`).
- `insert` replaces `\r\n` and lone `\r` with `\n` first. `newline` inserts `\n`. `continueLine` replaces the `\` before the cursor with `\n`.
- `up`/`down` move to the same grapheme column on the previous/next line, clamped. On the first line `up` (and on the last line `down`) walks history: the first `up` saves `text` as `draft`; entries are recalled newest first and stop at the oldest; `down` past the newest restores `draft`; the cursor goes to the end. Any other action leaves history mode (`historyIndex = null`).
- A word is a run of non-whitespace. `wordLeft` skips whitespace leftwards, then non-whitespace. `wordRight` skips whitespace rightwards, then non-whitespace. `deleteWord` deletes from the `wordLeft` position to the cursor. `deleteToLineStart` deletes from the line start to the cursor.
- `clear` empties the text; `set` replaces it with the cursor at the end; `submitted` appends `text` to `history` (unless it equals the last entry), then clears.

- [ ] **Step 4: Implement `keys.ts`**

First match wins:
1. `key.return && (key.shift || key.meta)` → `newline`
2. `input === "\n" || (key.ctrl && input === "j")` → `newline`
3. `key.return` → `continueLine` if the character before the cursor is `\` and the cursor is at the end of its line, else `submit`
4. `key.tab` → `complete`
5. `key.ctrl`: `c` interrupt, `d` eof, `a` lineStart, `e` lineEnd, `w` deleteWord, `u` deleteToLineStart, else `ignore`
6. `key.meta && (key.leftArrow || input === "b")` → `wordLeft`; `key.meta && (key.rightArrow || input === "f")` → `wordRight`
7. Arrows → `left` / `right` / `up` / `down`; `key.home` → `lineStart`; `key.end` → `lineEnd`
8. `key.backspace` → `backspace`; `key.delete` → `delete`
9. `key.escape || key.meta` → `ignore` (Esc routing is PR 2)
10. Non-empty `input` → `insert`; otherwise `ignore`

- [ ] **Step 5: Run them to verify they pass**

Run: `yarn vitest run src/repl/ui/editor.test.ts src/repl/ui/keys.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/repl/ui/editor.ts src/repl/ui/editor.test.ts src/repl/ui/keys.ts src/repl/ui/keys.test.ts
git commit -m "feat(repl): add multi-line editor state and key bindings"
```

### Task 6: Ring, Composer and App wiring

**Files:**
- Create: `src/repl/ui/Ring.tsx`, `src/repl/ui/Composer.tsx`
- Modify: `src/repl/ui/App.tsx`
- Test: `src/repl/ui/Ring.test.tsx`, `src/repl/ui/App.test.tsx`

**Interfaces:**
- Consumes: `segmentAt`, `Segment`, `Markers` (Task 1); `dispatch`, `DispatchResult`, `completeCommand`, `LineStyle` (Task 2); `editorReducer`, `emptyEditor` (Task 5); `keyToAction` (Task 5); `graphemeLength` from `@/lib/split-thread`.
- Produces:

```ts
// Ring.tsx
export function ringGlyph(count: number, limit: number): string;
export function ringColor(count: number, limit: number): "green" | "yellow" | "red";
export function ringCount(count: number, limit: number): string;
export function Ring(props: { segment: Segment; limit?: number }); // limit defaults to 300; PR 2 passes 298 for labelled posts
// Composer.tsx
export interface ComposerProps {
  markers: Markers;
  onSubmit(text: string): Promise<DispatchResult>;
  onHint(text: string): void;
  onExit(): void;
}
export function Composer(props: ComposerProps);
```

- [ ] **Step 1: Write the failing Ring tests**

```tsx
import { describe, it, expect } from "vitest";
import { renderToString } from "ink";
import { Ring, ringColor, ringCount, ringGlyph } from "./Ring";

describe("ring", () => {
  it.each([[0, "○"], [59, "○"], [60, "◔"], [149, "◔"], [150, "◑"], [224, "◑"], [225, "◕"], [299, "◕"], [300, "●"], [342, "●"]])(
    "%i → %s", (n, glyph) => expect(ringGlyph(n, 300)).toBe(glyph),
  );
  it("colours by count", () => {
    expect([259, 260, 300, 301].map((n) => ringColor(n, 300))).toEqual(["green", "yellow", "yellow", "red"]);
  });
  it("shows the overflow", () => {
    expect(ringCount(148, 300)).toBe("148/300");
    expect(ringCount(342, 300)).toBe("342/300 (−42)");
  });
  it("renders the segment status line", () => {
    const seg = { index: 2, total: 3, text: "x".repeat(148), region: "send" as const };
    expect(renderToString(<Ring segment={seg} />)).toContain("segment 2/3  ◑ 148/300");
    expect(renderToString(<Ring segment={{ ...seg, total: 1, index: 1 }} />)).not.toContain("segment");
    expect(renderToString(<Ring segment={{ ...seg, region: "kept" }} />)).toContain("kept");
  });
});
```

- [ ] **Step 2: Write the failing App tests**

```tsx
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { App } from "./App";
import { TEXT_HINT } from "@/repl/core/dispatch";
import { DEFAULT_MARKERS } from "@/repl/core/markers";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
function setup() {
  const app = render(<App markers={DEFAULT_MARKERS} kittyHint={false} />);
  const type = async (...chunks: string[]) => {
    for (const chunk of chunks) { app.stdin.write(chunk); await tick(); }
  };
  return { ...app, type };
}

describe("App", () => {
  it("keeps plain text with a hint on Enter", async () => {
    const { type, lastFrame } = setup();
    await type("hello", "\r");
    expect(lastFrame()).toContain(TEXT_HINT);
    expect(lastFrame()).toContain("bsky › hello");
  });
  it("runs /help and clears the composer", async () => {
    const { type, lastFrame } = setup();
    await type("/help", "\r");
    expect(lastFrame()).toContain("/exit");
    expect(lastFrame()).not.toContain("bsky › /help");
  });
  it("suggests a command and keeps the text", async () => {
    const { type, lastFrame } = setup();
    await type("/hlp", "\r");
    expect(lastFrame()).toContain("Unknown /hlp. Did you mean /help?");
    expect(lastFrame()).toContain("bsky › /hlp");
  });
  it.each([
    ["Shift+Enter (kitty)", ["a", "\x1b[13;2u", "b"]],
    ["Alt+Enter", ["a", "\x1b\r", "b"]],
    ["Ctrl+J", ["a", "\n", "b"]],
    ["trailing backslash", ["a\\", "\r", "b"]],
    ["bracketed paste", ["\x1b[200~a\r\nb\x1b[201~"]],
  ])("%s inserts a newline without submitting", async (_name, chunks) => {
    const { type, lastFrame } = setup();
    await type(...chunks);
    expect(lastFrame()).toMatch(/bsky › a\n\s+b/);
    expect(lastFrame()).not.toContain(TEXT_HINT);
  });
  it("shows the ring for the segment under the cursor", async () => {
    const { type, lastFrame } = setup();
    await type("one /// two");
    expect(lastFrame()).toContain("segment 2/2  ○ 3/300");
  });
  it("Ctrl+C clears the text, then hints at Ctrl+D", async () => {
    const { type, lastFrame } = setup();
    await type("abc", "\x03");
    expect(lastFrame()).not.toContain("abc");
    await type("\x03");
    expect(lastFrame()).toContain("Ctrl+D to exit");
  });
  it("Tab completes a command name", async () => {
    const { type, lastFrame } = setup();
    await type("/he", "\t");
    expect(lastFrame()).toContain("bsky › /help");
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `yarn vitest run src/repl/ui/Ring.test.tsx src/repl/ui/App.test.tsx`
Expected: FAIL, `./Ring` not found and the App tests time out on missing text.

- [ ] **Step 4: Implement `Ring.tsx`**

Glyph and colour follow Global Constraints (the yellow band starts at `limit − 40`); `ringCount` appends ` (−N)` with U+2212 only when over the limit. `Ring` counts `graphemeLength(segment.text)` and renders `segment {index}/{total}  ` (two spaces) only when `total > 1`, then the glyph and count in `ringColor`. In a `kept` or `cut` region it renders just the region name, dimmed.

- [ ] **Step 5: Implement `Composer.tsx` and wire it into `App`**

`Composer` holds `useReducer(editorReducer, emptyEditor())`. `useInput` maps each key with `keyToAction`:
- Editor actions go to the reducer.
- `submit`: ignore whitespace-only text; otherwise `await onSubmit(text)`, and on `"done"` dispatch `submitted`.
- `complete`: apply `completeCommand`'s result with `set` when the text changed; otherwise, with more than one candidate, `onHint` them as `/exit  /help  /quit`.
- `interrupt`: `clear` when there's text, else `onHint("Ctrl+D to exit")`.
- `eof`: `onExit()`.

`usePaste(text => dispatch({ type: "insert", text }))`.
Render: the first line prefixed `bsky › `, later lines indented by 7 spaces; the cursor is an inverse character (an inverse space at a line end); below that, `<Ring segment={segmentAt(text, cursor, markers)} />`.
In `App`, replace the static prompt with `<Composer>`. `print(text, style)` appends to the log; `onSubmit = (text) => dispatch(text, { print, exit })`; `onHint = (text) => print(text, "dim")`; `onExit` and `exit` are `useApp().exit`.

- [ ] **Step 6: Run the full suite**

Run: `yarn typecheck && yarn test:run`
Expected: PASS. If a key sequence doesn't parse in a test, read `node_modules/ink/build/parse-keypress.js` (or the PnP cache) before changing the mapping. That check is what's left of the §18 spike.

- [ ] **Step 7: Commit**

```bash
git add src/repl/ui/Ring.tsx src/repl/ui/Ring.test.tsx src/repl/ui/Composer.tsx src/repl/ui/App.tsx src/repl/ui/App.test.tsx
git commit -m "feat(repl): add composer with segment-aware character ring"
```

### Task 7: Kitty probe and the fallback hint

**Files:**
- Create: `src/repl/ui/terminal.ts`
- Modify: `src/repl/index.tsx` (`startRepl`)
- Test: `src/repl/ui/terminal.test.ts`

**Interfaces:**
- Consumes: `App`, `KITTY_HINT` (Task 3).
- Produces: `detectKittyKeyboard(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, timeoutMs = 500): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { detectKittyKeyboard } from "./terminal";

function fakeTerminal(reply?: string) {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
  const written: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      written.push(String(chunk));
      if (reply !== undefined) input.write(reply);
      done();
    },
  });
  return { input, written, stdin: input as unknown as NodeJS.ReadStream, stdout: output as unknown as NodeJS.WriteStream };
}

afterEach(() => vi.useRealTimers());

describe("detectKittyKeyboard", () => {
  it("detects support when the ?u reply comes before DA1", async () => {
    const t = fakeTerminal("\x1b[?0u\x1b[?62;22c");
    await expect(detectKittyKeyboard(t.stdin, t.stdout)).resolves.toBe(true);
    expect(t.written.join("")).toBe("\x1b[?u\x1b[c");
  });
  it("reports no support when only DA1 answers", async () => {
    const t = fakeTerminal("\x1b[?62;22c");
    await expect(detectKittyKeyboard(t.stdin, t.stdout)).resolves.toBe(false);
  });
  it("resolves on DA1 before any timer fires", async () => {
    vi.useFakeTimers();
    const t = fakeTerminal("\x1b[?62c");
    await expect(detectKittyKeyboard(t.stdin, t.stdout)).resolves.toBe(false);
  });
  it("times out at 500 ms when nothing answers", async () => {
    vi.useFakeTimers();
    const t = fakeTerminal();
    let settled = false;
    const result = detectKittyKeyboard(t.stdin, t.stdout).then((v) => { settled = true; return v; });
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(false);
  });
  it("restores the input stream", async () => {
    const t = fakeTerminal("\x1b[?62c");
    await detectKittyKeyboard(t.stdin, t.stdout);
    expect(t.input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(t.input.listenerCount("data")).toBe(0);
    expect(t.input.isPaused()).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `yarn vitest run src/repl/ui/terminal.test.ts`
Expected: FAIL, `./terminal` not found.

- [ ] **Step 3: Implement `detectKittyKeyboard`**

Attach a `data` listener first, then `setRawMode(true)` and `resume()`, then write `\x1b[?u\x1b[c`. Buffer replies; once the buffer matches DA1 (`/\x1b\[\?[\d;]*c/`), resolve with `/\x1b\[\?\d+u/.test(buffer)`. After `timeoutMs`, resolve `false`. Either way, remove the listener, clear the timer, `setRawMode(false)` and `pause()`.

- [ ] **Step 4: Use it in `startRepl`**

```ts
const kitty = await detectKittyKeyboard(process.stdin, process.stdout);
const app = render(<App markers={opts.markers} kittyHint={!kitty} />, {
  exitOnCtrlC: false,
  kittyKeyboard: { mode: kitty ? "enabled" : "disabled" },
});
await app.waitUntilExit();
```

- [ ] **Step 5: Run the full suite**

Run: `yarn typecheck && yarn test:run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/repl/ui/terminal.ts src/repl/ui/terminal.test.ts src/repl/index.tsx
git commit -m "feat(repl): probe kitty keyboard support and hint when Shift+Enter can't work"
```

### Task 8: CI smoke and lazy-loading check

**Files:**
- Modify: `.github/workflows/ci.yml`, `.github/workflows/release.yml`

- [ ] **Step 1: Add the Node smoke step**

In `ci.yml` after `Smoke test (Node ESM)`, and in `release.yml`'s `test` job after its `Smoke test (Node ESM)`:

```yaml
      - name: Smoke test (REPL, Node)
        env:
          BSKY_REPL_SMOKE: "1"
        run: yarn node dist/index.js repl
```

- [ ] **Step 2: Add the binary smoke step**

In `release.yml`'s `build-binaries` matrix, add `smoke: true` to the `bun-darwin-arm64`, `bun-linux-x64` and `bun-windows-x64` entries. After `Compile binary`:

```yaml
      - name: Smoke test (REPL, binary)
        if: matrix.smoke
        env:
          BSKY_REPL_SMOKE: "1"
        run: ./bsky repl
```

- [ ] **Step 3: Verify the build locally**

```bash
yarn build
ls dist/*.js
grep -l 'from "ink"' dist/*.js
BSKY_REPL_SMOKE=1 yarn node dist/index.js repl; echo "exit $?"
yarn node dist/index.js repl < /dev/null; echo "exit $?"
yarn node dist/index.js completions zsh | grep -c "auto-thread"
```

Expected:
- `dist/` has `index.js` plus at least one chunk, and `grep -l` lists chunk files only, never `dist/index.js`.
- The smoke run prints the header and `bsky ›`, then `exit 0`.
- The `< /dev/null` run prints help on stderr, then `exit 1`.
- The completions count is at least 1.

- [ ] **Step 4: Verify the Bun binary locally**

```bash
bun install
bun build --compile dist/index.js --outfile "$TMPDIR/bsky-repl"
BSKY_REPL_SMOKE=1 "$TMPDIR/bsky-repl" repl; echo "exit $?"
```

Expected: the header and `bsky ›`, then `exit 0`. `bun install` creates `node_modules/`, which is git-ignored; Bun can't resolve modules through Yarn PnP, so the release workflow does the same.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "ci: smoke-test the REPL on Node and native Bun binaries"
```

### Task 9: Docs and the manual terminal matrix

**Files:**
- Create: `docs/repl.md`
- Modify: `mkdocs.yml` (nav `- REPL: repl.md` after `Commands`), `README.md` (a `### REPL` subsection after `### Threads`, with one usage block and a link to the docs page), `docs/commands.md` (`## REPL` → `### bsky repl`, a one-line summary linking `repl.md`)

- [ ] **Step 1: Write `docs/repl.md`**

Sections:
- **REPL**: a preview that opens, edits and runs `/help` and `/exit`; posting lands in the next release.
- **Starting**: `bsky repl`; it needs an interactive terminal, otherwise it prints help and exits 1.
- **Keys**: the spec §6 table minus `Ctrl+G`, plus `Ctrl+C` (clear text) and `Ctrl+D` (exit); note that Shift+Enter needs the kitty keyboard protocol (iTerm2, Ghostty, kitty, WezTerm), and elsewhere Alt+Enter or Ctrl+J does the same.
- **Character ring**: the thresholds, and how `///`, `//>`, `<//` and `\` change the counted segment.
- **Commands**: `/help [command]`, `/exit` (`/quit`).
- **Options**: the Task 4 flag table, noting that threading, media and resume flags are accepted now and take effect as those features land.
- **Configuration**: the `[repl]` block, linking `configuration.md`.

- [ ] **Step 2: Run the manual matrix**

On `node dist/index.js repl` and on the Task 8 Bun binary, in macOS Terminal.app (no kitty: the hint shows; Alt+Enter needs "Use Option as Meta key"), iTerm2 or Ghostty (kitty: no hint), and the VS Code terminal:
- Shift+Enter (kitty only), Alt+Enter, Ctrl+J and a trailing `\` insert newlines; Enter submits.
- Pasting three lines inserts them; nothing submits.
- Resizing narrower and wider re-wraps the composer with no stray lines.
- `/exit` and Ctrl+D return to the shell at once.
- `kill -TERM <pid>` and `kill -HUP <pid>` from another shell leave the terminal normal: in `cat -v`, Shift+Enter shows `^M` (not `^[[13;2u`), and a paste shows no `^[[200~`.

Linux terminals and Windows Terminal are covered only by the CI smoke steps; record them as untested.

- [ ] **Step 3: Verify the docs build**

Run: `yarn typecheck && yarn test:run`, then `mkdocs build --strict` if `mkdocs` is installed.
Expected: PASS, and no broken nav entries.

- [ ] **Step 4: Commit**

```bash
git add docs/repl.md docs/commands.md mkdocs.yml README.md
git commit -m "docs(repl): document bsky repl foundations"
```

Put the Step 2 results table in the PR description. Don't push or open the PR until the user asks.
