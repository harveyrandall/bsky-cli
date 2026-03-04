import type { Command } from "commander";
import chalk from "chalk";
import type {
  AppBskyFeedPost,
  AppBskyFeedRepost,
  AppBskyFeedLike,
  AppBskyGraphFollow,
} from "@atproto/api";
import { getClient, isJson } from "../index.js";
import { outputJson } from "../lib/format.js";

export function registerNotifs(program: Command): void {
  program
    .command("notifs")
    .alias("notification")
    .description("Show notifications")
    .option("-a, --all", "Show all (including read)")
    .action(async (opts: { all?: boolean }) => {
      const agent = await getClient(program);
      const json = isJson(program);

      const resp = await agent.listNotifications({ limit: 50 });
      const notifs = resp.data.notifications;

      if (json) {
        for (const n of notifs) outputJson(n);
        return;
      }

      for (const n of notifs) {
        if (!opts.all && n.isRead) continue;

        process.stdout.write(chalk.redBright(n.author.handle));
        process.stdout.write(` [${n.author.displayName ?? ""}] `);
        console.log(chalk.blue(n.author.did));

        const record = n.record as Record<string, unknown>;
        switch (record.$type) {
          case "app.bsky.feed.post":
            console.log(` ${n.reason} to ${n.uri}`);
            break;
          case "app.bsky.feed.repost": {
            const repost = record as unknown as AppBskyFeedRepost.Record;
            console.log(` reposted ${repost.subject.uri}`);
            break;
          }
          case "app.bsky.feed.like": {
            const like = record as unknown as AppBskyFeedLike.Record;
            console.log(` liked ${like.subject.uri}`);
            break;
          }
          case "app.bsky.graph.follow":
            console.log(" followed you");
            break;
        }
      }

      // Mark as seen
      await agent.app.bsky.notification.updateSeen({
        seenAt: new Date().toISOString(),
      });
    });
}
