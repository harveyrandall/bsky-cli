import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";
import { Command, CommanderError } from "commander";
import type { LineStyle } from "./commands";
import type { SubmitOutcome } from "./repl";

// Commands that need the terminal, from an audit of createInterface, setRawMode,
// promptDateTime and stdin under src/commands. `drafts send` and the like are safe:
// getClient's own question has already been answered by the time the REPL is open.
export const BLOCKED = new Map<string, string>([
  ["repl", "you're already in it"],
  ["login", "run it in another terminal"],
  ["stream", "it runs until stopped: run it in another terminal"],
  ["create-thread", "use /thread instead"],
  ["config edit", "use /run config path, then edit it in another terminal"],
  ["schedule post", "use /new, then Scheduled post"],
  ["schedule edit", "it asks questions: run it in another terminal"],
  ["schedule delete", "it asks to confirm: run it in another terminal"],
  ["schedule uninstall", "it asks to confirm: run it in another terminal"],
  ["schedule watch", "it runs until stopped: run it in another terminal"],
]);

class Exited extends Error {
  constructor(readonly code: number) {
    super();
  }
}

/** Where the running command's output goes, for code running as part of it. */
const output = new AsyncLocalStorage<(text: string) => void>();

type Writer = typeof process.stdout.write;

/**
 * Sends what a command prints to its `sink`, and leaves everything else alone:
 * Ink draws through these same streams while the command runs. Only code running
 * as part of the command, by async context, is caught. Returns how to undo it.
 */
function redirect(): () => void {
  const { stdout, stderr } = process;
  const writers = [stdout.write, stderr.write] as const;
  const { log, info, warn, error } = console;
  const { exit } = process;
  const writer = (real: Writer, stream: NodeJS.WriteStream) =>
    function (this: unknown, chunk: Uint8Array | string, ...rest: never[]) {
      const sink = output.getStore();
      if (!sink) return real.call(stream, chunk, ...rest);
      sink(String(chunk));
      return true;
    } as Writer;
  const logger = (real: typeof console.log) => (...args: unknown[]) => {
    const sink = output.getStore();
    if (sink) sink(`${format(...args)}\n`);
    else real(...args);
  };
  stdout.write = writer(writers[0], stdout);
  stderr.write = writer(writers[1], stderr);
  Object.assign(console, { log: logger(log), info: logger(info), warn: logger(warn), error: logger(error) });
  process.exit = ((code?: number) => {
    if (output.getStore()) throw new Exited(Number(code ?? process.exitCode ?? 0));
    return exit(code);
  }) as typeof process.exit;
  return () => {
    [stdout.write, stderr.write] = writers;
    Object.assign(console, { log, info, warn, error });
    process.exit = exit;
  };
}

/**
 * What Ink draws through. A frame is never a command's output, even when something
 * running as part of the command caused it: React's work keeps the context that
 * scheduled it, so it would be caught, printed and drawn again.
 */
export function outsideCommands(stream: NodeJS.WriteStream): NodeJS.WriteStream {
  return new Proxy(stream, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (key === "write") return (...args: Parameters<Writer>) => output.exit(() => target.write(...args));
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const allCommands = (c: Command): Command[] => [c, ...c.commands.flatMap(allCommands)];

const named = (commands: readonly Command[], token: string) =>
  commands.find((c) => c.name() === token || c.aliases().includes(token));

/** `argv` without `command`'s options, on a throwaway: parsing fires listeners and sets values. */
function operands(command: Command, argv: readonly string[]): string[] {
  const probe = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  for (const option of command.options) probe.addOption(option);
  try {
    return probe.parseOptions([...argv]).operands;
  } catch {
    return [];
  }
}

/** The command and subcommand argv names, as Commander would find them. */
function commandPath(program: Command, argv: readonly string[]): string[] {
  const [first, second] = operands(program, argv);
  if (first === "help") return [first];
  const command = first === undefined ? undefined : named(program.commands, first);
  if (!command) return [];
  const sub = second === undefined ? undefined : named(command.commands, second);
  return sub ? [command.name(), sub.name()] : [command.name()];
}

/** Where in `argv` a post goes, by the command's own argument names. Anywhere else `#1` is just text. */
export function uriArguments(program: Command, argv: readonly string[]): Set<number> {
  const found = new Set<number>();
  const path = commandPath(program, argv);
  if (path.length === 0) return found;
  const target = path.reduce((c, name) => named(c.commands, name) ?? c, program);
  const args = target.registeredArguments;
  let at = argv.indexOf(operands(program, argv)[path.length - 1]) + 1;
  operands(target, argv.slice(at)).forEach((value, i) => {
    at = argv.indexOf(value, at);
    const arg = args[i] ?? (args.at(-1)?.variadic ? args.at(-1) : undefined);
    if (arg?.name() === "uri") found.add(at);
    at += 1;
  });
  return found;
}

function refusal(program: Command, argv: readonly string[]): string | undefined {
  const path = commandPath(program, argv);
  // Anything else would fall through to the default command: this REPL.
  if (path.length === 0) return `No such command: ${argv[0]}`;
  for (const key of [path.join(" "), path[0]]) {
    const why = BLOCKED.get(key);
    if (why) return `bsky ${key} can't run inside the REPL: ${why}`;
  }
  if (argv.includes("--stdin")) return `bsky ${path[0]} can't read from stdin inside the REPL`;
  return undefined;
}

/** The CLI commands that can run here, for `/help`, Tab and "did you mean". */
export function passthroughNames(program: Command): string[] {
  const visible = program.createHelp().visibleCommands(program);
  return visible.map((c) => c.name()).filter((name) => name !== "help" && !BLOCKED.has(name));
}

/** Whether `/name` is a CLI command: blocked ones get to say why, and aliases work. */
export const passthroughKnows = (program: Command, name: string) => named(program.commands, name) !== undefined;

export function passthroughFlags(program: Command, name: string): string[] {
  const command = program.commands.find((c) => c.name() === name);
  return command ? program.createHelp().visibleOptions(command).flatMap((o) => o.long ?? []) : [];
}

/** Runs a CLI command in this process, its output going to `print`. A failure keeps the text. */
export async function runPassthrough(
  program: Command,
  argv: readonly string[],
  io: { print(text: string, style?: LineStyle): void; profile?: string },
): Promise<SubmitOutcome> {
  const refused = refusal(program, argv);
  if (refused) {
    io.print(refused, "error");
    // `/login me hunter2` is the CLI's form: the password can't stay in the composer or history.
    return commandPath(program, argv)[0] === "login" ? "clear" : "keep";
  }
  // Outside the command's context, so that drawing the line isn't caught as more output.
  const print = (text: string, style?: LineStyle) => output.exit(() => io.print(text, style));
  let line = "";
  const sink = (text: string) => {
    const parts = (line + text).split("\n");
    line = parts.pop()!;
    for (const part of parts) print(part);
  };
  const { exitCode } = process;
  process.exitCode = undefined;
  for (const c of allCommands(program)) c.exitOverride();
  const restore = redirect();
  let ok = true;
  let thrown: string | undefined;
  try {
    const args = io.profile !== undefined ? ["-p", io.profile, ...argv] : [...argv];
    await output.run(sink, () => program.parseAsync(args, { from: "user" }));
    ok = !process.exitCode;
  } catch (err) {
    // Commander has already written its own errors, and a command that exits has said why.
    if (err instanceof Exited) ok = err.code === 0;
    else if (err instanceof CommanderError) ok = err.exitCode === 0;
    else {
      ok = false;
      thrown = err instanceof Error ? err.message : String(err);
    }
  } finally {
    restore();
    process.exitCode = exitCode;
  }
  if (line) print(line);
  if (thrown !== undefined) print(thrown, "error");
  return ok ? "done" : "keep";
}
