import chalk from "chalk";
import type { AppBskyFeedDefs, AppBskyFeedPost } from "@atproto/api";

export function printPost(post: AppBskyFeedDefs.PostView): void {
  const rec = post.record as AppBskyFeedPost.Record;

  // Author line
  process.stdout.write(chalk.redBright(post.author.handle));
  process.stdout.write(` [${post.author.displayName ?? ""}]`);
  console.log(` (${formatTime(rec.createdAt)})`);

  // Post text
  console.log(rec.text);

  // Embedded images
  if (post.embed) {
    const images = post.embed as { images?: Array<{ fullsize: string }> };
    if (images.images) {
      for (const img of images.images) {
        console.log(` {${img.fullsize}}`);
      }
    }
  }

  // Engagement counts
  console.log(
    ` 👍(${post.likeCount ?? 0})⚡(${post.repostCount ?? 0})↩️ (${post.replyCount ?? 0})`,
  );

  // Reply reference
  if (rec.reply?.parent) {
    process.stdout.write(" > ");
    console.log(chalk.blue(rec.reply.parent.uri));
  }

  // Post URI
  process.stdout.write(" - ");
  console.log(chalk.blue(post.uri));
  console.log();
}

export function printActor(actor: {
  handle: string;
  displayName?: string;
  did: string;
}): void {
  process.stdout.write(chalk.redBright(actor.handle));
  process.stdout.write(` [${actor.displayName ?? ""}] `);
  console.log(chalk.blue(actor.did));
}

export function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toISOString();
}

export function outputJson(data: unknown): void {
  console.log(JSON.stringify(data));
}
