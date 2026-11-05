import { looksLikeRef } from "./refs";
import type { Repl, SubmitOutcome } from "./repl";
import { isCooldown, type Cooldown } from "./types";

export type LineStyle = "normal" | "dim" | "error";

export interface CommandContext {
  print(text: string, style?: LineStyle): void;
  exit(): void;
  /** CLI commands that can run in the REPL. */
  passthrough?: { names(): string[]; knows(name: string): boolean; run(argv: string[]): Promise<SubmitOutcome> };
  repl: Repl;
  /** Open text in $EDITOR, handing it the terminal. */
  edit(text: string): Promise<string>;
}

export interface ReplCommand {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly usage: string;
  readonly summary: string;
  /** Gets the raw, trimmed text after the name instead of shell-style tokens, so posts keep newlines and apostrophes. */
  readonly raw?: boolean;
  run(args: string[], ctx: CommandContext, rest: string): void | SubmitOutcome | Promise<void | SubmitOutcome>;
}

function cooldown(name: string, value: string | undefined): Cooldown {
  const n = value === undefined || value === "" ? NaN : Number(value);
  if (!isCooldown(n)) throw new Error(`${name} must be 0, 5, 10 or 15`);
  return n;
}

const engagement = (name: "like" | "unlike" | "repost" | "unrepost", summary: string): ReplCommand => ({
  name,
  aliases: [],
  usage: `/${name} <ref>`,
  summary,
  run([ref], ctx) {
    if (ref === undefined) throw new Error(`Usage: /${name} <ref>`);
    return ctx.repl.engage(name, ref);
  },
});

function onOrOff(name: string, value?: string): boolean {
  if (value !== "on" && value !== "off") throw new Error(`Usage: /settings ${name} on|off`);
  return value === "on";
}

function threadLabel(value?: string): "append" | "prepend" | false {
  if (value === "append" || value === "prepend") return value;
  if (value === "off") return false;
  throw new Error("Usage: /settings thread-label off|append|prepend");
}

export const COMMANDS: readonly ReplCommand[] = [
  {
    name: "help",
    aliases: [],
    usage: "/help [command]",
    summary: "List commands, or show help for one",
    async run([name], ctx) {
      if (name === undefined) {
        const width = Math.max(...COMMANDS.map((c) => c.usage.length)) + 2;
        for (const c of COMMANDS) ctx.print(c.usage.padEnd(width) + c.summary);
        const cli = ctx.passthrough?.names().filter((n) => !findCommand(n));
        if (cli?.length) ctx.print(`↗ From the CLI: ${cli.map((n) => `/${n}`).join(" ")}`);
        return;
      }
      const bare = name.replace(/^\//, "");
      const cmd = findCommand(bare);
      if (!cmd && ctx.passthrough?.knows(bare)) {
        await ctx.passthrough.run([bare, "--help"]);
        return;
      }
      if (!cmd) {
        ctx.print(unknownMessage(name, ctx.passthrough?.names()), "error");
        return;
      }
      ctx.print(cmd.usage);
      ctx.print(cmd.summary);
      if (cmd.aliases.length) ctx.print(`Aliases: ${cmd.aliases.map((a) => `/${a}`).join(", ")}`);
    },
  },
  {
    name: "thread",
    aliases: [],
    raw: true,
    usage: "/thread [--undo N] [--pace N] [text|ref]",
    summary: "Start or continue a thread",
    run(_args, ctx, rest) {
      const opts: { undo?: Cooldown; pace?: Cooldown } = {};
      let text = rest;
      for (let m = /^\s*--(undo|pace)(?:\s+(\S+))?/.exec(text); m; m = /^\s*--(undo|pace)(?:\s+(\S+))?/.exec(text)) {
        opts[m[1] as "undo" | "pace"] = cooldown(`--${m[1]}`, m[2]);
        text = text.slice(m[0].length);
      }
      text = text.trim();
      // Quotes turn something that looks like a ref into text: /thread "42". Any others are part of the post.
      const quoted = /^(["'])([\s\S]*)\1$/.exec(text);
      if (quoted && looksLikeRef(quoted[2])) return ctx.repl.startThread(quoted[2], { ...opts, asText: true });
      return ctx.repl.startThread(text === "" ? undefined : text, opts);
    },
  },
  {
    name: "reply",
    aliases: [],
    raw: true,
    usage: "/reply <ref> [text]",
    summary: "Reply once to a post",
    run(_args, ctx, rest) {
      const m = /^\s*(\S+)\s*([\s\S]*)$/.exec(rest);
      if (!m) throw new Error("Usage: /reply <ref> [text]");
      return ctx.repl.reply(m[1], m[2] === "" ? undefined : m[2]);
    },
  },
  {
    name: "reply-from",
    aliases: [],
    usage: "/reply-from <ref>",
    summary: "Continue the thread from another post",
    run([ref], ctx) {
      if (ref === undefined) throw new Error("Usage: /reply-from <ref>");
      return ctx.repl.replyFrom(ref);
    },
  },
  {
    name: "post",
    aliases: [],
    raw: true,
    usage: "/post [text]",
    summary: "Post on its own",
    run(_args, ctx, rest) {
      return ctx.repl.post(rest.trim() === "" ? undefined : rest);
    },
  },
  {
    name: "quote",
    aliases: [],
    raw: true,
    usage: "/quote <ref> [text]",
    summary: "Quote a post",
    run(_args, ctx, rest) {
      const m = /^\s*(\S+)\s*([\s\S]*)$/.exec(rest);
      if (!m) throw new Error("Usage: /quote <ref> [text]");
      return ctx.repl.quote(m[1], m[2] === "" ? undefined : m[2]);
    },
  },
  {
    name: "new",
    aliases: [],
    usage: "/new",
    summary: "Pick what to write next (stops the thread)",
    run(_args, ctx) {
      return ctx.repl.newMenu();
    },
  },
  {
    name: "attach",
    aliases: [],
    usage: '/attach <path…> [--alt "…"]',
    summary: "Stage images or a video for the next post",
    async run(args, ctx) {
      const at = args.indexOf("--alt");
      const paths = at === -1 ? args : args.filter((_, i) => i !== at && i !== at + 1);
      if (paths.length === 0 || (at !== -1 && args[at + 1] === undefined)) throw new Error('Usage: /attach <path…> [--alt "…"]');
      await ctx.repl.attach(paths, at === -1 ? undefined : args[at + 1]);
    },
  },
  {
    name: "detach",
    aliases: [],
    usage: "/detach [n|all]",
    summary: "Unstage one file, or all of them",
    run([which = "all"], ctx) {
      const n = Number(which);
      if (which !== "all" && !(Number.isInteger(n) && n > 0)) throw new Error("Usage: /detach [n|all]");
      ctx.repl.detach(which === "all" ? "all" : n);
    },
  },
  {
    name: "delete",
    aliases: [],
    usage: "/delete <ref>",
    summary: "Delete one of your posts",
    run([ref], ctx) {
      if (ref === undefined) throw new Error("Usage: /delete <ref>");
      return ctx.repl.deletePost(ref);
    },
  },
  {
    name: "undo",
    aliases: [],
    usage: "/undo",
    summary: "Delete the last post you made",
    run(_args, ctx) {
      return ctx.repl.undo();
    },
  },
  {
    name: "drafts",
    aliases: [],
    usage: "/drafts [id]",
    summary: "List drafts, or load one into the composer",
    run([id], ctx) {
      return ctx.repl.drafts(id);
    },
  },
  {
    name: "switch",
    aliases: [],
    usage: "/switch [profile]",
    summary: "Post as another account, or the unnamed profile's",
    run([profile], ctx) {
      return ctx.repl.switchProfile(profile ?? "");
    },
  },
  {
    name: "open",
    aliases: [],
    usage: "/open <ref>",
    summary: "Open a post in your browser",
    run([ref], ctx) {
      if (ref === undefined) throw new Error("Usage: /open <ref>");
      return ctx.repl.openPost(ref);
    },
  },
  {
    name: "view",
    aliases: [],
    usage: "/view <ref>",
    summary: "Print a post and its replies",
    async run([ref], ctx) {
      if (ref === undefined) throw new Error("Usage: /view <ref>");
      if (!ctx.passthrough) throw new Error("CLI commands aren't available here");
      const uri = await ctx.repl.uriOf(ref);
      if (!uri) return "keep";
      return ctx.passthrough.run(["thread", uri]);
    },
  },
  {
    name: "copy",
    aliases: [],
    usage: "/copy <ref>",
    summary: "Copy a post's link",
    run([ref], ctx) {
      if (ref === undefined) throw new Error("Usage: /copy <ref>");
      return ctx.repl.copyPost(ref);
    },
  },
  engagement("like", "Like a post"),
  engagement("unlike", "Remove your like of a post"),
  engagement("repost", "Repost a post"),
  engagement("unrepost", "Remove your repost of a post"),
  {
    name: "run",
    aliases: [],
    usage: "/run <command> [args]",
    summary: "Run a CLI command, even one with the same name as a REPL command",
    async run(args, ctx) {
      if (args.length === 0) throw new Error("Usage: /run <command> [args]");
      if (!ctx.passthrough) throw new Error("CLI commands aren't available here");
      return ctx.passthrough.run(args);
    },
  },
  {
    name: "edit",
    aliases: [],
    raw: true,
    usage: "/edit [text]",
    summary: "Write in $EDITOR (Ctrl+G)",
    async run(_args, ctx, rest) {
      return { restore: await ctx.edit(rest) };
    },
  },
  {
    name: "auto-thread",
    aliases: [],
    usage: "/auto-thread [on|off]",
    summary: "Toggle starting a thread from plain text",
    run([value], ctx) {
      if (value !== undefined && value !== "on" && value !== "off") throw new Error("Usage: /auto-thread [on|off]");
      ctx.repl.setAutoThread(value === undefined ? undefined : value === "on");
    },
  },
  {
    name: "settings",
    aliases: [],
    usage: "/settings [name value]",
    summary: "Change undo, pace, force-alt, thread-label or verbose, then show them",
    async run([key, value], ctx) {
      if (key === undefined) await ctx.repl.askSettings();
      else if (key === "undo" || key === "pace") ctx.repl.setCooldown(key, cooldown(key, value));
      else if (key === "force-alt") ctx.repl.setSetting({ forceAlt: onOrOff(key, value) });
      else if (key === "verbose") ctx.repl.setSetting({ verbose: onOrOff(key, value) });
      else if (key === "thread-label") ctx.repl.setSetting({ threadLabel: threadLabel(value) });
      else throw new Error("Usage: /settings [undo|pace N] [force-alt|verbose on|off] [thread-label off|append|prepend]");
      ctx.print(ctx.repl.settingsLine());
    },
  },
  {
    name: "history",
    aliases: [],
    usage: "/history",
    summary: "List this session's posts",
    run(_args, ctx) {
      const { registry } = ctx.repl;
      if (registry.entries().length === 0) ctx.print("No posts yet", "dim");
      for (const e of registry.entries()) ctx.print(`${registry.format(e, ctx.repl.settings().verbose)} "${e.excerpt}"`);
    },
  },
  {
    name: "retry",
    aliases: [],
    usage: "/retry",
    summary: "Resend what couldn't be sent (network error, rate limit or expired session)",
    async run(_args, ctx) {
      await ctx.repl.retry();
    },
  },
  {
    name: "exit",
    aliases: ["quit"],
    usage: "/exit",
    summary: "Leave the REPL (same as Ctrl+D)",
    run(_args, ctx) {
      ctx.exit();
    },
  },
];

const allNames = () => COMMANDS.flatMap((c) => [c.name, ...c.aliases]);

export function findCommand(name: string): ReplCommand | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases.includes(name));
}

/**
 * Shell-style split: `'…'` is literal, `"…"` honours only `\"` and `\\`,
 * and outside quotes `\x` is `x`. Adjacent parts join into one token.
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let token: string | null = null;
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) {
      if (token !== null) tokens.push(token);
      token = null;
      i++;
      continue;
    }
    token ??= "";
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) throw new Error("Unclosed ' quote");
      token += input.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      for (i++; input[i] !== '"'; ) {
        if (i >= input.length) throw new Error('Unclosed " quote');
        const escaped = input[i] === "\\" && (input[i + 1] === '"' || input[i + 1] === "\\");
        token += escaped ? input[i + 1] : input[i];
        i += escaped ? 2 : 1;
      }
      i++;
    } else if (c === "\\" && i + 1 < input.length) {
      token += input[i + 1];
      i += 2;
    } else {
      token += c;
      i++;
    }
  }
  if (token !== null) tokens.push(token);
  return tokens;
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/** Closest candidate within edit distance 2; ties go to the first alphabetically. */
export function suggest(name: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const c of [...candidates].sort()) {
    const d = distance(name.toLowerCase(), c);
    if (d < bestDistance) [best, bestDistance] = [c, d];
  }
  return best;
}

export function unknownMessage(name: string, others: readonly string[] = []): string {
  const close = suggest(name, [...allNames(), ...others]);
  return close ? `Unknown /${name}. Did you mean /${close}?` : `Unknown /${name}. /help lists commands.`;
}

interface Completed {
  text: string;
  cursor: number;
  candidates: string[];
}

/** What Tab can offer beyond the REPL's own command names. */
export interface Completions {
  cliNames: readonly string[];
  flags(command: string): readonly string[];
  /** Most useful first. */
  labels(): readonly string[];
  paths(partial: string): readonly string[];
}

const MOST_LABELS = 8;

/** `token` carried as far as `matches` agree, or the matches if they don't. A folder stays open for the next Tab. */
function extend(before: string, token: string, matches: readonly string[]): Completed {
  const at = (text: string, candidates: string[] = []) => ({ text, cursor: text.length, candidates });
  if (matches.length === 0) return at(before + token);
  if (matches.length === 1) return at(`${before}${matches[0]}${matches[0].endsWith("/") ? "" : " "}`);
  let common = [...matches[0]]; // by character: two emoji can begin with the same half
  for (const m of matches) while (!m.startsWith(common.join(""))) common.pop();
  const shared = common.join("");
  return shared.length > token.length ? at(before + shared) : at(before + token, [...matches]);
}

/** Tab completion for a bare `/name` with the cursor at its end. */
export function completeCommand(text: string, cursor: number, others: readonly string[] = []): Completed {
  if (cursor !== text.length || !/^\/[a-z-]*$/.test(text)) return { text, cursor, candidates: [] };
  const prefix = text.slice(1);
  return extend("/", prefix, [...new Set([...allNames(), ...others])].filter((n) => n.startsWith(prefix)).sort());
}

/** Whether `text` stops inside a quote or after a lone backslash, where Tab can't tell what the word is. */
function unfinished(text: string): boolean {
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && quote !== "'") {
      if (++i === text.length) return true;
    } else if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    }
  }
  return quote !== "";
}

/** Tab: command names, then flags, `/attach` paths and labels where a ref goes. */
export function complete(text: string, cursor: number, sources: Completions): Completed {
  const unchanged = { text, cursor, candidates: [] };
  if (cursor !== text.length) return unchanged;
  if (!/\s/.test(text)) {
    const names = completeCommand(text, cursor, sources.cliNames);
    return { ...names, candidates: names.candidates.map((n) => `/${n}`) };
  }
  if (!/^\/[a-z-]+\s/.test(text) || unfinished(text)) return unchanged;
  const token = /(?:\\.|[^\s\\])*$/.exec(text)![0];
  const before = text.slice(0, text.length - token.length);
  const starting = (list: readonly string[]) => list.filter((s) => s.startsWith(token));
  const words = before.trim().split(/\s+/);
  const viaRun = words[0] === "/run";
  if (viaRun && words.length === 1) return extend(before, token, starting(sources.cliNames));
  const name = viaRun ? words[1] : words[0].slice(1);
  const native = viaRun ? undefined : findCommand(name);
  if (token.startsWith("-")) return extend(before, token, starting(native ? (native.usage.match(/--[a-z-]+/g) ?? []) : sources.flags(name)));
  if (native?.name === "attach") return completePath(before, token, sources);
  if (native?.usage.includes("<ref>") && words.length === 1) {
    const done = extend(before, token, starting(sources.labels()));
    return { ...done, candidates: done.candidates.slice(0, MOST_LABELS) };
  }
  return unchanged;
}

function completePath(before: string, token: string, sources: Completions): Completed {
  const partial = token.replace(/\\(.)/g, "$1");
  const matches = sources.paths(partial).map((p) => p.replace(/[\s\\'"]/g, "\\$&"));
  const done = extend(before, token, matches);
  const folder = partial.lastIndexOf("/") + 1;
  return { ...done, candidates: done.candidates.map((p) => p.replace(/\\(.)/g, "$1").slice(folder)) };
}
