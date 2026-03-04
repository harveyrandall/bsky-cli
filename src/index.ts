import { Command } from "commander";
import { loadConfig } from "./config.js";
import { createClient } from "./client.js";
import { registerLogin } from "./commands/login.js";
import { registerTimeline, registerStream } from "./commands/timeline.js";
import { registerThread } from "./commands/thread.js";
import { registerPost, registerReply, registerQuote } from "./commands/post.js";
import { registerDelete } from "./commands/delete.js";
import { registerLike, registerLikes } from "./commands/like.js";
import { registerRepost, registerReposts } from "./commands/repost.js";
import {
  registerFollow,
  registerUnfollow,
  registerFollows,
  registerFollowers,
  registerBlock,
  registerUnblock,
  registerBlocks,
  registerMute,
} from "./commands/social.js";
import { registerSearch, registerSearchActors } from "./commands/search.js";
import {
  registerProfile,
  registerProfileUpdate,
  registerSession,
} from "./commands/profile.js";
import { registerNotifs } from "./commands/notification.js";
import { registerReport, registerModList } from "./commands/moderation.js";
import { registerAppPassword } from "./commands/password.js";
import { registerInviteCodes } from "./commands/invite.js";
import type { AtpAgent } from "@atproto/api";
import type { Config } from "./lib/types.js";

const program = new Command();

program
  .name("bsky")
  .description("A CLI client for Bluesky")
  .version("0.1.0")
  .option("--json", "Output as JSON")
  .option("-p, --profile <name>", "Profile name")
  .option("-v, --verbose", "Verbose output");

// Helper to get authenticated client within commands
export async function getClient(program: Command): Promise<AtpAgent> {
  const opts = program.opts();
  const config = await loadConfig(opts.profile);
  const prefix = opts.profile ? `${opts.profile}-` : "";
  return createClient(config, prefix);
}

export async function getConfig(program: Command): Promise<Config> {
  const opts = program.opts();
  return loadConfig(opts.profile);
}

export function isJson(program: Command): boolean {
  return program.opts().json === true;
}

// Register all commands
registerLogin(program);
registerTimeline(program);
registerStream(program);
registerThread(program);
registerPost(program);
registerReply(program);
registerQuote(program);
registerDelete(program);
registerLike(program);
registerLikes(program);
registerRepost(program);
registerReposts(program);
registerFollow(program);
registerUnfollow(program);
registerFollows(program);
registerFollowers(program);
registerBlock(program);
registerUnblock(program);
registerBlocks(program);
registerMute(program);
registerSearch(program);
registerSearchActors(program);
registerProfile(program);
registerProfileUpdate(program);
registerSession(program);
registerNotifs(program);
registerReport(program);
registerModList(program);
registerAppPassword(program);
registerInviteCodes(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
