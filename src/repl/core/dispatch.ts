import { findCommand, tokenize, unknownMessage, type CommandContext } from "./commands";

// PR 2 replaces this once plain text starts a thread.
export const TEXT_HINT = "Posting from the REPL isn't available yet — /help lists commands.";

export type Parsed =
  | { kind: "empty" }
  | { kind: "text"; text: string }
  | { kind: "command"; name: string; rest: string };

/** `/name …` is a command; a leading `\/` escapes it into text. */
export function parseInput(input: string): Parsed {
  const trimmed = input.trimStart();
  if (trimmed === "") return { kind: "empty" };
  if (trimmed.startsWith("\\/")) return { kind: "text", text: input.replace("\\/", "/") };
  const match = /^\/([a-z]\S*)([\s\S]*)$/.exec(trimmed);
  if (match) return { kind: "command", name: match[1], rest: match[2].trim() };
  return { kind: "text", text: input };
}

/** "keep" leaves the text in the composer so the user can fix it. */
export type DispatchResult = "done" | "keep";

export async function dispatch(input: string, ctx: CommandContext): Promise<DispatchResult> {
  const parsed = parseInput(input);
  if (parsed.kind === "empty") return "done";
  if (parsed.kind === "text") {
    ctx.print(TEXT_HINT, "dim");
    return "keep";
  }
  const cmd = findCommand(parsed.name);
  if (!cmd) {
    ctx.print(unknownMessage(parsed.name), "error");
    return "keep";
  }
  // The REPL never exits on an error: report it and keep the text.
  try {
    await cmd.run(tokenize(parsed.rest), ctx);
    return "done";
  } catch (err) {
    const message = err instanceof Error ? err.message || err.name : String(err);
    ctx.print(`/${parsed.name}: ${message}`, "error");
    return "keep";
  }
}
