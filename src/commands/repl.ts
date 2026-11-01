import { InvalidArgumentError, type Command } from "commander";
import { resolveMarkers } from "@/repl/core/markers";

export function parseCooldown(value: string): number {
  if (!["0", "5", "10", "15"].includes(value)) throw new InvalidArgumentError("must be 0, 5, 10 or 15");
  return Number(value);
}

// Only markers are read in PR 1; the other flags exist so config and
// completions see them, and are used from PR 2 on.
export function registerRepl(program: Command): void {
  program
    .command("repl")
    .description("Interactive REPL for writing threads")
    .option("-t, --auto-thread", "Start a thread when you type plain text")
    .option("--no-auto-thread", "Don't start a thread from plain text")
    .option("-l, --prefix-thread", "Label posts per thread (A1, B2…)")
    .option("--undo <seconds>", "Undo window before each post: 0, 5, 10 or 15", parseCooldown)
    .option("--pace <seconds>", "Minimum seconds between posts: 0, 5, 10 or 15", parseCooldown)
    .option("-f, --force-alt", "Require alt text for media")
    .option("--thread-label", "Add 🧵 to posts in the active thread")
    .option("--prepend-thread-label", "Put the 🧵 first instead of last")
    .option("-r, --resume [id]", 'Resume a saved session (id, prefix or "last")')
    .option("--resumable", "Save this session so it can be resumed (default)")
    .option("-R, --no-resumable", "Don't save this session")
    .action(async (opts, cmd: Command) => {
      // Ink and React load only here, so other commands stay fast.
      if (process.env.BSKY_REPL_SMOKE === "1") {
        const { smokeFrame } = await import("@/repl");
        process.stdout.write(smokeFrame() + "\n");
        return;
      }
      if (!process.stdin.isTTY || !process.stdout.isTTY) cmd.help({ error: true });
      const markers = resolveMarkers(opts);
      const { startRepl } = await import("@/repl");
      await startRepl({ markers });
    });
}
