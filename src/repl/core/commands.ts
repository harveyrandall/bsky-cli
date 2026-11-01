export type LineStyle = "normal" | "dim" | "error";

export interface CommandContext {
  print(text: string, style?: LineStyle): void;
  exit(): void;
}

export interface ReplCommand {
  name: string;
  aliases: string[];
  usage: string;
  summary: string;
  run(args: string[], ctx: CommandContext): void | Promise<void>;
}

export const COMMANDS: readonly ReplCommand[] = [
  {
    name: "help",
    aliases: [],
    usage: "/help [command]",
    summary: "List commands, or show help for one",
    run([name], ctx) {
      if (name === undefined) {
        for (const c of COMMANDS) ctx.print(c.usage.padEnd(18) + c.summary);
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
      if (end < 0) throw new Error("Unclosed quote");
      token += input.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      for (i++; input[i] !== '"'; ) {
        if (i >= input.length) throw new Error("Unclosed quote");
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
