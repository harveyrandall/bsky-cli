import { looksLikeRef } from "./refs";
import type { Repl, SubmitOutcome } from "./repl";
import { isCooldown, type Cooldown } from "./types";

export type LineStyle = "normal" | "dim" | "error";

export interface CommandContext {
  print(text: string, style?: LineStyle): void;
  exit(): void;
  repl: Repl;
}

export interface ReplCommand {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly usage: string;
  readonly summary: string;
  /** Gets the raw text after the name instead of shell-style tokens, so posts keep newlines and apostrophes. */
  readonly raw?: boolean;
  run(args: string[], ctx: CommandContext, rest: string): void | SubmitOutcome | Promise<void | SubmitOutcome>;
}

function cooldown(name: string, value: string | undefined): Cooldown {
  const n = value === undefined || value === "" ? NaN : Number(value);
  if (!isCooldown(n)) throw new Error(`${name} must be 0, 5, 10 or 15`);
  return n;
}

export const COMMANDS: readonly ReplCommand[] = [
  {
    name: "help",
    aliases: [],
    usage: "/help [command]",
    summary: "List commands, or show help for one",
    run([name], ctx) {
      if (name === undefined) {
        const width = Math.max(...COMMANDS.map((c) => c.usage.length)) + 2;
        for (const c of COMMANDS) ctx.print(c.usage.padEnd(width) + c.summary);
        return;
      }
      const cmd = findCommand(name.replace(/^\//, ""));
      if (!cmd) {
        ctx.print(unknownMessage(name), "error");
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
    usage: "/settings [undo|pace N]",
    summary: "Show or change undo and pace",
    async run([key, value], ctx) {
      if (key === undefined) await ctx.repl.askSettings();
      else if (key === "undo" || key === "pace") ctx.repl.setCooldown(key, cooldown(key, value));
      else throw new Error("Usage: /settings [undo|pace N]");
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
    summary: "Resend the last batch that failed",
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
    const d = distance(name, c);
    if (d < bestDistance) [best, bestDistance] = [c, d];
  }
  return best;
}

export function unknownMessage(name: string): string {
  const close = suggest(name, allNames());
  return close ? `Unknown /${name}. Did you mean /${close}?` : `Unknown /${name}. /help lists commands.`;
}

/** Tab completion for a bare `/name` with the cursor at its end. */
export function completeCommand(
  text: string,
  cursor: number,
): { text: string; cursor: number; candidates: string[] } {
  const unchanged = { text, cursor, candidates: [] };
  if (cursor !== text.length || !/^\/[a-z-]*$/.test(text)) return unchanged;
  const prefix = text.slice(1);
  const matches = allNames().filter((n) => n.startsWith(prefix)).sort();
  if (matches.length === 0) return unchanged;
  if (matches.length === 1) return { text: `/${matches[0]} `, cursor: matches[0].length + 2, candidates: [] };
  let common = matches[0];
  for (const n of matches) while (!n.startsWith(common)) common = common.slice(0, -1);
  if (common.length > prefix.length) return { text: `/${common}`, cursor: common.length + 1, candidates: [] };
  return { ...unchanged, candidates: matches };
}
