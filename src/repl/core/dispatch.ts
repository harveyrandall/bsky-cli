import { findCommand, tokenize, unknownMessage, type CommandContext } from "./commands";
import type { SubmitOutcome } from "./repl";

export type Parsed =
  | { kind: "empty" }
  | { kind: "text"; text: string }
  | { kind: "command"; name: string; rest: string };

/**
 * `/name …` is a command; a leading `\/` escapes it into text. Leading
 * whitespace is ignored, and a name starts with a lowercase letter, so `/`,
 * `/ x` and `/Help` are text.
 */
export function parseInput(input: string): Parsed {
  const trimmed = input.trimStart();
  if (trimmed === "") return { kind: "empty" };
  if (trimmed.startsWith("\\/")) return { kind: "text", text: input.replace("\\/", "/") };
  const match = /^\/([a-z]\S*)([\s\S]*)$/.exec(trimmed);
  if (match) return { kind: "command", name: match[1], rest: match[2].trim() };
  return { kind: "text", text: input };
}

export async function dispatch(input: string, ctx: CommandContext): Promise<SubmitOutcome> {
  const parsed = parseInput(input);
  if (parsed.kind === "empty") return "done";
  // The REPL never exits on an error: report it and keep the text.
  try {
    if (parsed.kind === "text") return await ctx.repl.submitText(parsed.text);
    const cmd = findCommand(parsed.name);
    if (!cmd && ctx.passthrough?.names().includes(parsed.name)) {
      await ctx.passthrough.run([parsed.name, ...tokenize(parsed.rest)]);
      return "done";
    }
    if (!cmd) {
      ctx.print(unknownMessage(parsed.name, ctx.passthrough?.names()), "error");
      return "keep";
    }
    return (await cmd.run(cmd.raw ? [] : tokenize(parsed.rest), ctx, parsed.rest)) ?? "done";
  } catch (err) {
    const message = err instanceof Error ? err.message || err.name : String(err);
    ctx.print(parsed.kind === "command" ? `/${parsed.name}: ${message}` : message, "error");
    return "keep";
  }
}
