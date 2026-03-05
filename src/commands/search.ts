import type { Command } from "commander";
import type { AppBskyFeedDefs, AppBskyFeedPost } from "@atproto/api";
import { getClient, isJson } from "@/index";
import { printPost, outputJson } from "@/lib/format";

export function registerSearch(program: Command): void {
  program
    .command("search")
    .description("Search posts")
    .argument("<terms...>", "Search terms")
    .option("-n <count>", "Number of results", "100")
    .action(async (terms: string[], opts: { n: string }) => {
      const agent = await getClient(program);
      const json = isJson(program);
      const n = parseInt(opts.n, 10);
      const query = terms.join(" ");

      let results: AppBskyFeedDefs.PostView[] = [];
      let cursor: string | undefined;

      while (true) {
        const resp = await agent.app.bsky.feed.searchPosts({
          q: query,
          cursor,
          limit: 100,
        });

        results.push(...resp.data.posts);
        cursor = resp.data.cursor;

        if (!cursor || results.length > n) break;
      }

      // Sort by date ascending
      results.sort((a, b) => {
        const ta = new Date(
          (a.record as AppBskyFeedPost.Record).createdAt,
        ).getTime();
        const tb = new Date(
          (b.record as AppBskyFeedPost.Record).createdAt,
        ).getTime();
        return ta - tb;
      });

      if (results.length > n) {
        results = results.slice(results.length - n);
      }

      if (json) {
        for (const p of results) outputJson(p);
      } else {
        for (const p of results) printPost(p);
      }
    });
}

export function registerSearchUsers(program: Command): void {
  program
    .command("search-users")
    .description("Search for users")
    .argument("<terms...>", "Search terms")
    .option("-n <count>", "Number of results", "100")
    .action(async (terms: string[], opts: { n: string }) => {
      const agent = await getClient(program);
      const n = parseInt(opts.n, 10);
      const query = terms.join(" ");

      const resp = await agent.searchActors({
        term: query,
        limit: n,
      });

      for (const actor of resp.data.actors) {
        outputJson(actor);
      }
    });
}
