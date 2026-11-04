import { InvalidArgumentError, type Command } from "commander";
import type { AppBskyFeedDefs, AtpAgent } from "@atproto/api";
import { getClient } from "@/index";
import { createPost } from "@/commands/post";
import { activeConfigPath } from "@/toml-config";
import { resolveMarkers } from "@/repl/core/markers";
import { mediaOptions } from "@/repl/core/media";
import type { PostLookup } from "@/repl/core/refs";
import type { ReplAgent, ReplSettings } from "@/repl/core/repl";
import { isAtUri, isCid, isDid, isHandle, toStrongRef, type StrongRef } from "@/repl/core/types";

const COOLDOWNS = [0, 5, 10, 15];

export function parseCooldown(value: string): number {
  if (!COOLDOWNS.map(String).includes(value)) throw new InvalidArgumentError("must be 0, 5, 10 or 15");
  return Number(value);
}

/** Config values skip Commander's parsers, so check [repl] undo and pace here. */
function checkCooldowns(opts: { undo?: unknown; pace?: unknown }): void {
  for (const key of ["undo", "pace"] as const) {
    const value = opts[key];
    if (value !== undefined && !COOLDOWNS.includes(value as number)) {
      throw new Error(`Invalid [repl] ${key} = ${JSON.stringify(value)}: must be 0, 5, 10 or 15`);
    }
  }
}

const asRef = (r?: { uri: string; cid: string }): StrongRef | undefined =>
  r && isAtUri(r.uri) && isCid(r.cid) ? { uri: r.uri, cid: r.cid } : undefined;

/** A post from the API, or undefined if its refs or author fail a guard. Non-string text becomes "". */
function toLookup(post: AppBskyFeedDefs.PostView): PostLookup | undefined {
  const record = post.record as { text?: unknown; reply?: { root?: { uri: string; cid: string }; parent?: { uri: string; cid: string } } };
  const ref = asRef(post);
  if (!ref || !isDid(post.author.did) || !isHandle(post.author.handle)) return undefined;
  const root = asRef(record.reply?.root);
  const parent = asRef(record.reply?.parent);
  // A reply with bad refs would pass for a thread root.
  if (record.reply && !(root && parent)) return undefined;
  return {
    ...ref,
    authorDid: post.author.did,
    authorHandle: post.author.handle,
    text: typeof record.text === "string" ? record.text : "",
    root,
    parent,
  };
}

/** The few agent calls the REPL needs, with every response checked. */
export function replAgent(agent: AtpAgent): ReplAgent {
  const did = agent.session?.did;
  if (!isDid(did)) throw new Error("Not logged in — run `bsky login` first");
  return {
    selfDid: did,
    async resolveHandle(handle) {
      const res = await agent.resolveHandle({ handle });
      if (!isDid(res.data.did)) throw new Error(`Unexpected DID for @${handle}: ${res.data.did}`);
      return res.data.did;
    },
    async getPosts(uris) {
      const res = await agent.getPosts({ uris });
      return res.data.posts.flatMap((p) => toLookup(p) ?? []);
    },
    async post(text, reply, media) {
      const target = reply ? { reply: reply.parent, replyRoot: reply.root } : {};
      return toStrongRef(await createPost(agent, text, { ...target, ...mediaOptions(media) }));
    },
  };
}

// Flags whose features land in later releases; the rest are read now.
const NOT_YET = new Set(["resume", "resumable"]);

export function registerRepl(program: Command): void {
  program
    .command("repl", { isDefault: true })
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
    .allowExcessArguments()
    .action(async (opts, cmd: Command) => {
      // Being the default command, this also receives mistyped commands. Commander
      // keeps its suggestions in unknownCommand(), which its types leave out.
      if (cmd.args.length > 0) {
        const owner = program.args[0] === "repl" ? cmd : program;
        (owner as Command & { unknownCommand(): never }).unknownCommand();
      }
      // Config is checked first so the smoke run catches a broken [repl] section too.
      const markers = resolveMarkers(opts);
      checkCooldowns(opts);
      // Ink and React load only here, so other commands stay fast.
      if (process.env.BSKY_REPL_SMOKE === "1") {
        const { smokeFrame } = await import("@/repl");
        process.stdout.write(smokeFrame() + "\n");
        return;
      }
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        // Bare `bsky` without a terminal prints the CLI's help, as it always has.
        if (program.args[0] !== "repl") program.help({ error: true });
        process.stderr.write("bsky repl needs an interactive terminal: stdin and stdout must both be terminals.\n");
        cmd.help({ error: true });
      }
      for (const option of cmd.options) {
        const name = option.attributeName();
        // Negatable flags share one value; report only the form that was typed.
        const typed = cmd.getOptionValueSource(name) === "cli" && option.negate === (cmd.getOptionValue(name) === false);
        if (typed && NOT_YET.has(name)) {
          process.stderr.write(`bsky repl: ${option.long} isn't used yet; it takes effect in a later release.\n`);
        }
      }
      const agent = await getClient(program);
      const settings: ReplSettings = {
        autoThread: opts.autoThread === true,
        prefixThread: opts.prefixThread === true,
        threadLabel: opts.prependThreadLabel ? "prepend" : opts.threadLabel ? "append" : false,
        undo: opts.undo,
        pace: opts.pace,
        askToSave: opts.askToSave !== false,
        verbose: program.opts().verbose === true,
        forceAlt: opts.forceAlt === true,
      };
      const { startRepl } = await import("@/repl");
      await startRepl({
        markers,
        settings,
        agent: replAgent(agent),
        handle: agent.session?.handle ?? "",
        configPath: activeConfigPath(),
        profile: program.opts().profile ?? process.env.BSKY_PROFILE,
      });
    });
}
