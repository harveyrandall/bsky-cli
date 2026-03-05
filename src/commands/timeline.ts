import type { Command } from "commander";
import type { AppBskyFeedDefs, AppBskyFeedPost } from "@atproto/api";
import { getClient, isJson } from "@/index";
import { printPost, printStreamPost, outputJson } from "@/lib/format";
import type { JetstreamCommitEvent, JetstreamEvent } from "@/lib/types";
import WebSocket from "ws";

const DEFAULT_JETSTREAM = "wss://jetstream1.us-east.bsky.network/subscribe";

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
    .description("Stream live posts from the network")
    .option("--cursor <cursor>", "Resume cursor (Unix microseconds)")
    .option("-H, --handle <handle>", "Filter to a specific user")
    .option("--pattern <regex>", "Filter post text by regex")
    .option("--jetstream <url>", "Override Jetstream endpoint")
    .action(
      async (opts: {
        cursor?: string;
        handle?: string;
        pattern?: string;
        jetstream?: string;
      }) => {
        const json = isJson(program);

        // Build Jetstream URL
        const wsUrl = new URL(opts.jetstream ?? DEFAULT_JETSTREAM);
        wsUrl.searchParams.set("wantedCollections", "app.bsky.feed.post");

        // Resolve --handle to DID for server-side filtering
        let filterHandle: string | null = null;
        if (opts.handle) {
          const agent = await getClient(program);
          if (opts.handle === "self") {
            wsUrl.searchParams.set("wantedDids", agent.session!.did);
            filterHandle = agent.session!.handle;
          } else if (opts.handle.startsWith("did:")) {
            wsUrl.searchParams.set("wantedDids", opts.handle);
          } else {
            const profile = await agent.getProfile({ actor: opts.handle });
            wsUrl.searchParams.set("wantedDids", profile.data.did);
            filterHandle = opts.handle;
          }
        }

        if (opts.cursor) {
          wsUrl.searchParams.set("cursor", opts.cursor);
        }

        const re = opts.pattern ? new RegExp(opts.pattern) : null;
        let lastCursor = "";

        const ws = new WebSocket(wsUrl.toString());

        process.on("SIGINT", () => {
          if (lastCursor) {
            console.error(`\nCursor: ${lastCursor}`);
          }
          ws.close();
          process.exit(0);
        });

        ws.on("message", (data: Buffer) => {
          try {
            const event = JSON.parse(data.toString()) as JetstreamEvent;
            lastCursor = String(event.time_us);

            // Only process commit events
            if (event.kind !== "commit") return;

            const commit = (event as JetstreamCommitEvent).commit;

            // Only process new posts
            if (commit.operation !== "create") return;
            if (commit.collection !== "app.bsky.feed.post") return;

            const text = commit.record?.text;
            if (!text) return;

            // Apply regex filter
            if (re && !re.test(text)) return;

            if (json) {
              outputJson(event);
            } else {
              printStreamPost(
                event.did,
                filterHandle,
                text,
                commit.rkey,
                commit.collection,
              );
            }
          } catch {
            // Skip malformed messages
          }
        });

        ws.on("error", (err: Error) => {
          console.error("WebSocket error:", err.message);
          process.exit(1);
        });

        ws.on("close", () => {
          if (lastCursor) {
            console.error(`Cursor: ${lastCursor}`);
          }
          process.exit(0);
        });

        // Keep process alive
        await new Promise(() => {});
      },
    );
}
