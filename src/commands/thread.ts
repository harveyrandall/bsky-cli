import type { Command } from "commander";
import type { AppBskyFeedDefs } from "@atproto/api";
import { getClient, isJson } from "@/index";
import { printPost, outputJson } from "@/lib/format";

function normalizeUri(uri: string): string {
  if (!uri.startsWith("at://did:plc:")) {
    return "at://did:plc:" + uri;
  }
  return uri;
}

export function registerThread(program: Command): void {
  program
    .command("thread")
    .description("Show thread")
    .argument("<uri>", "Post URI")
    .option("-n <count>", "Number of items", "30")
    .action(async (uri: string, opts: { n: string }) => {
      const agent = await getClient(program);
      const json = isJson(program);
      const depth = parseInt(opts.n, 10);

      const resp = await agent.getPostThread({
        uri: normalizeUri(uri),
        depth,
      });

      const thread =
        resp.data.thread as AppBskyFeedDefs.ThreadViewPost;

      if (json) {
        outputJson(thread);
        if (thread.replies) {
          for (const r of thread.replies) outputJson(r);
        }
        return;
      }

      const replies = (thread.replies ?? []) as AppBskyFeedDefs.ThreadViewPost[];
      replies.reverse();

      printPost(thread.post);
      for (const r of replies) {
        if (r.post) printPost(r.post);
      }
    });
}
