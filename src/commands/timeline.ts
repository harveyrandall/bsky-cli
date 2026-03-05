import type { Command } from "commander";
import type { AppBskyFeedDefs, AppBskyFeedPost } from "@atproto/api";
import { getClient, isJson } from "@/index";
import { printPost, outputJson } from "@/lib/format";
import { loadConfig } from "@/config";
import WebSocket from "ws";

export function registerTimeline(program: Command): void {
  program
    .command("timeline")
    .alias("tl")
    .description("Show timeline")
    .option("-H, --handle <handle>", "User handle")
    .option("-n <count>", "Number of items", "30")
    .action(async (opts: { handle?: string; n: string }) => {
      const agent = await getClient(program);
      const json = isJson(program);
      const n = parseInt(opts.n, 10);

      let feed: AppBskyFeedDefs.FeedViewPost[] = [];
      let cursor: string | undefined;

      while (true) {
        if (opts.handle) {
          const handle =
            opts.handle === "self" ? agent.session!.did : opts.handle;
          const resp = await agent.getAuthorFeed({
            actor: handle,
            cursor,
            limit: n,
          });
          feed.push(...resp.data.feed);
          cursor = resp.data.cursor;
        } else {
          const resp = await agent.getTimeline({
            cursor,
            limit: n,
          });
          feed.push(...resp.data.feed);
          cursor = resp.data.cursor;
        }

        if (!cursor || feed.length > n) break;
      }

      // Sort by date ascending
      feed.sort((a, b) => {
        const ta = new Date(
          (a.post.record as AppBskyFeedPost.Record).createdAt,
        ).getTime();
        const tb = new Date(
          (b.post.record as AppBskyFeedPost.Record).createdAt,
        ).getTime();
        return ta - tb;
      });

      if (feed.length > n) {
        feed = feed.slice(feed.length - n);
      }

      if (json) {
        for (const p of feed) outputJson(p);
      } else {
        for (const p of feed) printPost(p.post);
      }
    });
}

export function registerStream(program: Command): void {
  program
    .command("stream")
    .description("Show timeline as stream")
    .option("--cursor <cursor>", "Cursor position")
    .option("-H, --handle <handle>", "User handle filter")
    .option("--pattern <regex>", "Filter pattern")
    .option("--reply <text>", "Auto-reply text")
    .action(
      async (opts: {
        cursor?: string;
        handle?: string;
        pattern?: string;
        reply?: string;
      }) => {
        const globalOpts = program.opts();
        const config = await loadConfig(globalOpts.profile);
        const json = isJson(program);

        let host = config.bgs || config.host;
        const wsUrl = new URL(host);
        wsUrl.protocol = "wss:";
        wsUrl.pathname = "/xrpc/com.atproto.sync.subscribeRepos";
        if (opts.cursor) {
          wsUrl.searchParams.set("cursor", opts.cursor);
        }

        const re = opts.pattern ? new RegExp(opts.pattern) : null;

        const ws = new WebSocket(wsUrl.toString());

        process.on("SIGINT", () => {
          ws.close();
          process.exit(0);
        });

        ws.on("message", async (data: Buffer) => {
          try {
            // The firehose sends CBOR-encoded frames
            // For a full implementation, we'd need @atproto/common for CBOR decoding
            // For now, we attempt to extract post text from the binary data
            const text = data.toString("utf-8");

            if (json) {
              // Output raw frame as base64 for JSON mode
              outputJson({
                type: "frame",
                data: data.toString("base64"),
              });
            }

            if (re && !re.test(text)) return;

            // If we need full post rendering, we'd decode CBOR here
            // This is a simplified version - full implementation requires
            // cbor-x or @ipld/dag-cbor for proper CBOR/CAR decoding
          } catch {
            // Skip malformed frames
          }
        });

        ws.on("error", (err) => {
          console.error("WebSocket error:", err.message);
          process.exit(1);
        });

        // Keep process alive
        await new Promise(() => {});
      },
    );
}
