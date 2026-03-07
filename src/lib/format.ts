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

export function printStreamPost(
  did: string,
  handle: string | null,
  text: string,
  rkey: string,
  collection: string,
): void {
  const author = handle ?? did;
  process.stdout.write(chalk.redBright(author));
  console.log(`: ${text}`);
  console.log(`  at://${did}/${collection}/${rkey}`);
  console.log();
}

export function printConvo(
  convo: {
    id: string;
    members: Array<{ handle: string; displayName?: string; did: string }>;
    unreadCount: number;
    muted: boolean;
    status?: string;
    lastMessage?: { $type?: string; text?: string; sentAt?: string };
  },
  myDid: string,
): void {
  const others = convo.members.filter((m) => m.did !== myDid);
  const names = others.map((m) => m.handle).join(", ");

  process.stdout.write(chalk.redBright(names));
  if (convo.unreadCount > 0) {
    process.stdout.write(chalk.yellow(` (${convo.unreadCount} unread)`));
  }
  if (convo.muted) {
    process.stdout.write(chalk.gray(" [muted]"));
  }
  if (convo.status === "request") {
    process.stdout.write(chalk.magenta(" [request]"));
  }
  console.log();

  if (convo.lastMessage && "text" in convo.lastMessage && convo.lastMessage.text) {
    const preview =
      convo.lastMessage.text.length > 80
        ? convo.lastMessage.text.slice(0, 80) + "..."
        : convo.lastMessage.text;
    console.log(` ${preview}`);
    if (convo.lastMessage.sentAt) {
      console.log(` ${chalk.gray(formatTime(convo.lastMessage.sentAt))}`);
    }
  }

  process.stdout.write(" - ");
  console.log(chalk.blue(convo.id));
  console.log();
}

export function printMessage(
  message: {
    $type?: string;
    id: string;
    text?: string;
    sender: { did: string };
    sentAt: string;
  },
  members: Array<{ handle: string; did: string; displayName?: string }>,
): void {
  const sender = members.find((m) => m.did === message.sender.did);
  const senderName = sender?.handle ?? message.sender.did;

  process.stdout.write(chalk.redBright(senderName));
  console.log(` (${formatTime(message.sentAt)})`);

  if ("text" in message && message.text) {
    console.log(message.text);
  } else {
    console.log(chalk.gray("[deleted]"));
  }

  process.stdout.write(" - ");
  console.log(chalk.blue(message.id));
  console.log();
}

export function outputJson(data: unknown): void {
  console.log(JSON.stringify(data));
}
