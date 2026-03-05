import type { Command } from "commander";
import { AppBskyFeedDefs } from "@atproto/api";
import { getClient, isJson } from "@/index";
import { printPost, outputJson } from "@/lib/format";

export function registerBookmarks(program: Command): void {
  const bookmarks = program
    .command("bookmarks")
    .description("Manage bookmarks");

  bookmarks
    .command("create")
    .description("Bookmark a post")
    .argument("<uri...>", "Post URI(s) to bookmark")
    .action(async (uris: string[]) => {
      const agent = await getClient(program);

      for (const uri of uris) {
        const atUri = uri.startsWith("at://") ? uri : `at://did:plc:${uri}`;
        const parts = atUri.split("/");
        const rkey = parts[parts.length - 1];
        const collection = parts[parts.length - 2];
        const did = parts[2];

        const record = await agent.com.atproto.repo.getRecord({
          repo: did,
          collection,
          rkey,
        });

        await agent.app.bsky.bookmark.createBookmark({
          uri: record.data.uri,
          cid: record.data.cid!,
        });
        console.log(record.data.uri);
      }
    });

  bookmarks
    .command("delete")
    .description("Remove a bookmark")
    .argument("<uri...>", "Post URI(s) to unbookmark")
    .action(async (uris: string[]) => {
      const agent = await getClient(program);

      for (const uri of uris) {
        const atUri = uri.startsWith("at://") ? uri : `at://did:plc:${uri}`;
        await agent.app.bsky.bookmark.deleteBookmark({ uri: atUri });
        console.log(atUri);
      }
    });

  bookmarks
    .command("get")
    .description("List bookmarked posts")
    .option("-n, --count <number>", "Number of bookmarks to show", "50")
    .action(async (opts: { count: string }) => {
      const agent = await getClient(program);
      const json = isJson(program);
      const limit = parseInt(opts.count, 10);

      let cursor: string | undefined;
      let remaining = limit;

      do {
        const resp = await agent.app.bsky.bookmark.getBookmarks({
          limit: Math.min(remaining, 50),
          cursor,
        });

        for (const bookmark of resp.data.bookmarks) {
          if (json) {
            outputJson(bookmark);
          } else if (AppBskyFeedDefs.isPostView(bookmark.item)) {
            printPost(bookmark.item);
          }
        }

        remaining -= resp.data.bookmarks.length;
        cursor = resp.data.cursor;
      } while (cursor && remaining > 0);
    });
}
