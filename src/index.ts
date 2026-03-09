import { Command } from "commander";
import { loadConfig } from "@/config";
import { createClient } from "@/client";
import { registerLogin } from "@/commands/login";
import { registerTimeline, registerStream } from "@/commands/timeline";
import { registerThread } from "@/commands/thread";
import { registerPost, registerReply, registerQuote } from "@/commands/post";
import { registerDelete } from "@/commands/delete";
import { registerLike, registerLikes } from "@/commands/like";
import { registerRepost, registerReposts } from "@/commands/repost";
import {
  registerFollow,
  registerUnfollow,
  registerFollows,
  registerFollowers,
  registerBlock,
  registerUnblock,
  registerBlocks,
  registerMute,
} from "@/commands/social";
import { registerSearch, registerSearchUsers } from "@/commands/search";
import {
  registerProfile,
  registerProfileUpdate,
  registerSession,
} from "@/commands/profile";
import { registerNotifs } from "@/commands/notification";
import { registerReport, registerModList } from "@/commands/moderation";
import { registerBookmarks } from "@/commands/bookmark";
import { registerAppPassword } from "@/commands/password";
import { registerInviteCodes } from "@/commands/invite";
import { registerCompletions } from "@/commands/completions";
import { registerDrafts, syncNetworkDrafts } from "@/commands/draft";
import { registerCreateThread } from "@/commands/create-thread";
import type { AtpAgent } from "@atproto/api";
import type { Config } from "@/lib/types";

const program = new Command();

program
  .name("bsky")
  .description("A CLI client for Bluesky")
  .version("1.0.0")
  .option("--json", "Output as JSON")
  .option("-p, --profile <name>", "Profile name")
  .option("-v, --verbose", "Verbose output");

function resolveProfile(program: Command): string | undefined {
  return program.opts().profile ?? process.env.BSKY_PROFILE;
}

// Helper to get authenticated client within commands
let syncDone = false;

export async function getClient(program: Command): Promise<AtpAgent> {
  const profile = resolveProfile(program);
  const config = await loadConfig(profile);
  const prefix = profile ? `${profile}-` : "";
  const agent = await createClient(config, prefix);

  // One-time sync check: successful auth proves connectivity
  if (!syncDone) {
    syncDone = true;
    await syncNetworkDrafts(agent, profile);
  }

  return agent;
}

export async function getConfig(program: Command): Promise<Config> {
  const profile = resolveProfile(program);
  return loadConfig(profile);
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
registerSearchUsers(program);
registerProfile(program);
registerProfileUpdate(program);
registerSession(program);
registerNotifs(program);
registerReport(program);
registerModList(program);
registerBookmarks(program);
registerAppPassword(program);
registerInviteCodes(program);
registerCompletions(program);
registerDrafts(program);
registerCreateThread(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
