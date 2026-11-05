import { join } from "node:path";
import { InvalidArgumentError, type Command } from "commander";
import type { AppBskyFeedDefs, AtpAgent } from "@atproto/api";
import { bskyDir, findProfile, profileNames } from "@/config";
import { getClient } from "@/index";
import { likePost, unlikePost } from "@/commands/like";
import { createPost } from "@/commands/post";
import { repostPost, unrepostPost } from "@/commands/repost";
import { activeConfigPath } from "@/toml-config";
import { resolveMarkers, type Markers } from "@/repl/core/markers";
import { mediaOptions } from "@/repl/core/media";
import { passthroughFlags, passthroughKnows, passthroughNames, runPassthrough, uriArguments } from "@/repl/core/passthrough";
import { SessionStore, newSessionId, resolveId, type ReplSessionFile } from "@/repl/core/persist";
import type { PostLookup } from "@/repl/core/refs";
import type { ReplAgent, ReplSettings } from "@/repl/core/repl";
import { isAtUri, isCid, isDid, isHandle, toStrongRef, type IsoUtc, type StrongRef } from "@/repl/core/types";

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
    async post(text, reply, media, quote) {
      const target = reply ? { reply: reply.parent, replyRoot: reply.root } : {};
      return toStrongRef(await createPost(agent, text, { ...target, ...mediaOptions(media), quote }));
    },
    like: async (post) => void (await likePost(agent, post)),
    unlike: (post) => unlikePost(agent, post.uri),
    repost: async (post) => void (await repostPost(agent, post)),
    unrepost: (post) => unrepostPost(agent, post.uri),
    deletePost: async (uri) => void (await agent.deletePost(uri)),
  };
}

/** The session to open and lock: undefined for a new one, null to quit. */
async function chooseSession(opts: { resume?: string | boolean; resumable?: boolean }, store: SessionStore): Promise<ReplSessionFile | undefined | null> {
  if (opts.resumable === false && opts.resume === undefined) return undefined;
  const listings = await store.list();
  let id: string | undefined | null;
  if (typeof opts.resume === "string") {
    id = resolveId(opts.resume, listings);
  } else if (listings.length > 0) {
    const { pickSession } = await import("@/repl");
    id = await pickSession(store, listings);
  }
  if (id === undefined || id === null) return id;
  const session = id as ReplSessionFile["id"];
  if (!(await store.lock(session))) {
    throw new Error(`Session ${id} is open in another REPL. If it isn't, delete ${store.lockPath(id)}`);
  }
  try {
    return await store.load(session);
  } catch (err) {
    await store.unlock(session);
    throw new Error(`Can't open session ${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function registerRepl(program: Command): void {
  program
    .command("repl", { isDefault: true })
    .description("Interactive composer for posts, threads, quotes, scheduled posts and drafts")
    .option("-t, --auto-thread", "Start a thread when you type plain text")
    .option("--no-auto-thread", "Don't start a thread from plain text")
    .option("-l, --prefix-thread", "Label posts per thread (A1, B2…)")
    .option("--undo <seconds>", "Undo window before each post: 0, 5, 10 or 15", parseCooldown)
    .option("--pace <seconds>", "Minimum seconds between posts: 0, 5, 10 or 15", parseCooldown)
    .option("-f, --force-alt", "Require alt text for media")
    .option("--thread-label", "Add 🧵 to posts in the active thread")
    .option("--prepend-thread-label", "Put the 🧵 first instead of last")
    .option("-r, --resume [id]", 'Resume a saved session: an id, a prefix or "last"; with no id, show the list')
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
      const keep = opts.keepSessions ?? 50;
      if (!Number.isInteger(keep) || keep < 1) throw new Error(`Invalid [repl] keep-sessions = ${JSON.stringify(keep)}: must be a whole number above 0`);
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
      const store = new SessionStore(join(bskyDir(), "repl", "sessions"));
      const resume = await chooseSession(opts, store);
      if (resume === null) return;
      if (resume) program.setOptionValue("profile", resume.profile);
      try {
        await openRepl(program, opts, store, keep, markers, resume);
      } catch (err) {
        if (resume) await store.unlock(resume.id);
        throw err;
      }
    });
}

async function openRepl(
  program: Command,
  opts: Record<string, unknown>,
  store: SessionStore,
  keep: number,
  flagMarkers: Markers,
  resume: ReplSessionFile | undefined,
): Promise<void> {
  const agent = await getClient(program);
  if (resume && agent.session?.did !== resume.did) {
    throw new Error(`Session ${resume.id} belongs to @${resume.handle}: log in to that account, then try again`);
  }
  const fromFlags: ReplSettings = {
    autoThread: opts.autoThread === true,
    prefixThread: opts.prefixThread === true,
    threadLabel: opts.prependThreadLabel ? "prepend" : opts.threadLabel ? "append" : false,
    undo: opts.undo as ReplSettings["undo"],
    pace: opts.pace as ReplSettings["pace"],
    askToSave: opts.askToSave !== false,
    verbose: program.opts().verbose === true,
    forceAlt: opts.forceAlt === true,
  };
  const client = replAgent(agent);
  let profile: string | undefined = program.opts().profile;
  const { startRepl } = await import("@/repl");
  await startRepl({
    markers: resume?.settings.markers ?? flagMarkers,
    settings: resume?.settings ?? fromFlags,
    agent: client,
    handle: agent.session?.handle ?? "",
    configPath: activeConfigPath(),
    profile,
    passthrough: {
      names: () => passthroughNames(program),
      knows: (name) => passthroughKnows(program, name),
      flags: (name) => passthroughFlags(program, name),
      uriArguments: (argv) => uriArguments(program, argv),
      run: (argv, print) => runPassthrough(program, argv, { print, profile }),
    },
    async switchAccount(name) {
      // getClient would stay on that account, whatever the profile.
      if (process.env.BSKY_HANDLE && process.env.BSKY_PASSWORD) {
        throw new Error("BSKY_HANDLE and BSKY_PASSWORD choose the account here: unset them to switch");
      }
      // `-p ?` lists them and exits, which here would end the REPL.
      if (name === "?") throw new Error(`Pick a profile: ${profileNames().join(", ") || "there are none yet"}`);
      const before = profile;
      // "" is the unnamed profile: it beats BSKY_PROFILE and the config, as undefined wouldn't.
      const target = await findProfile(name);
      program.setOptionValue("profile", target);
      try {
        const next = await getClient(program);
        profile = target;
        return { agent: replAgent(next), handle: next.session?.handle ?? "", profile: target };
      } catch (err) {
        program.setOptionValue("profile", before);
        throw err;
      }
    },
    // A resumed session keeps saving even with -R, or what you answer would be asked again.
    session:
      resume || opts.resumable !== false
        ? {
            store,
            id: resume?.id ?? newSessionId(),
            createdAt: resume?.createdAt ?? (new Date().toISOString() as IsoUtc),
            did: client.selfDid,
            keep,
            resume,
          }
        : undefined,
  });
}
