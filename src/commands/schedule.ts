import chalk from "chalk";
import { resolve } from "node:path";
import { stdin, stderr } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { getClient, isJson } from "@/index";
import {
  saveScheduledPost,
  listScheduledPosts,
  deleteScheduledPost,
  updateScheduledPost,
} from "@/scheduled";
import { saveDraft } from "@/drafts";
import { createPost } from "@/commands/post";
import { graphemeLength } from "@/lib/split-thread";
import { promptDateTime, formatLocalDateTime } from "@/lib/date-prompt";
import { outputJson } from "@/lib/format";
import type { ScheduledPost } from "@/lib/types";

const PAGE_SIZE = 5;

/**
 * Find all scheduled posts that are due and publish them.
 * Returns the number of successfully posted items.
 */
async function postDueItems(program: Command): Promise<number> {
  const profile = program.opts().profile;
  const posts = await listScheduledPosts(profile);
  const due = posts.filter((p) => new Date(p.scheduledAt) <= new Date());

  if (due.length === 0) return 0;

  const agent = await getClient(program);
  let posted = 0;

  for (const post of due) {
    try {
      const result = await createPost(agent, post.text, {
        images: post.images,
        imageAlts: post.imageAlts,
        video: post.video,
        videoAlt: post.videoAlt,
      });
      await deleteScheduledPost(post.id, profile);
      console.log(result.uri);
      posted++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to post ${post.id}: ${msg}`);
    }
  }

  return posted;
}

/**
 * Display a page of scheduled posts with 1-based indices.
 */
function displayPosts(posts: ScheduledPost[], offset: number): void {
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    const idx = offset + i + 1;
    const preview =
      post.text.length > 60 ? post.text.slice(0, 57) + "..." : post.text;
    const date = formatLocalDateTime(post.scheduledAt);
    console.log(`${chalk.blue(`${idx}.`)} ${preview} ${chalk.dim(`(${date})`)}`);
    if (post.images?.length) {
      console.log(`   ${chalk.dim(`${post.images.length} image(s)`)}`);
    }
    if (post.video) {
      console.log(`   ${chalk.dim("1 video")}`);
    }
  }
}

/**
 * Interactive post selection — shows paginated list and prompts for index.
 * Returns the selected post or null if cancelled.
 */
async function selectPost(
  rl: ReturnType<typeof createInterface>,
  allPosts: ScheduledPost[],
): Promise<ScheduledPost | null> {
  if (allPosts.length === 0) {
    console.error("No scheduled posts.");
    return null;
  }

  let offset = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = allPosts.slice(offset, offset + PAGE_SIZE);
    displayPosts(page, offset);

    const hasMore = offset + PAGE_SIZE < allPosts.length;
    const hint = hasMore ? ' or "more" to see more' : "";
    const answer = await rl.question(`\nSelect a post number${hint}: `);
    const trimmed = answer.trim().toLowerCase();

    if (trimmed === "" || trimmed === "q" || trimmed === "quit" || trimmed === "cancel") {
      return null;
    }

    if (trimmed === "more" && hasMore) {
      offset += PAGE_SIZE;
      continue;
    }

    const num = parseInt(trimmed, 10);
    if (isNaN(num) || num < 1 || num > allPosts.length) {
      console.error(`Please enter a number between 1 and ${allPosts.length}.`);
      continue;
    }

    return allPosts[num - 1];
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export function registerSchedule(program: Command): void {
  const schedule = program
    .command("schedule")
    .description("Manage scheduled posts");

  // ── schedule post ──────────────────────────────────────────────
  schedule
    .command("post")
    .description("Schedule a post for future publication")
    .argument("[text...]", "Post text")
    .option("--stdin", "Read text from stdin")
    .option("-i, --image <files...>", "Image files to attach")
    .option("--image-alt <alts...>", "Alt text for images")
    .option("--video <file>", "Video file to attach")
    .option("--video-alt <alt>", "Alt text for video")
    .action(
      async (
        textParts: string[],
        opts: {
          stdin?: boolean;
          image?: string[];
          imageAlt?: string[];
          video?: string;
          videoAlt?: string;
        },
      ) => {
        const profile = program.opts().profile;

        let text = textParts.join(" ");
        if (opts.stdin) {
          text = await readStdin();
        }
        if (!text.trim()) {
          console.error("Error: post text is required");
          process.exit(1);
        }

        const rl = createInterface({ input: stdin, output: stderr });
        try {
          const scheduledAt = await promptDateTime(rl);

          const post = await saveScheduledPost(
            {
              scheduledAt,
              text,
              images: opts.image?.map((p) => resolve(p)),
              imageAlts: opts.imageAlt,
              video: opts.video ? resolve(opts.video) : undefined,
              videoAlt: opts.videoAlt,
            },
            profile,
          );

          console.error(
            `Scheduled post saved: ${chalk.blue(post.id)} (${formatLocalDateTime(scheduledAt)})`,
          );
        } finally {
          rl.close();
        }
      },
    );

  // ── schedule list ──────────────────────────────────────────────
  schedule
    .command("list")
    .alias("ls")
    .description("List scheduled posts")
    .option("-n, --number <num>", "Number of posts to show", "5")
    .option("-a, --all", "Show all scheduled posts")
    .option("-o, --order <order>", "Sort order: asc (soonest first) or desc", "asc")
    .action(
      async (opts: { number: string; all?: boolean; order: string }) => {
        const profile = program.opts().profile;
        const json = isJson(program);
        let posts = await listScheduledPosts(profile);

        if (posts.length === 0) {
          if (!json) console.error("No scheduled posts.");
          return;
        }

        if (opts.order === "desc") {
          posts = posts.reverse();
        }

        if (!opts.all) {
          const limit = parseInt(opts.number, 10) || 5;
          posts = posts.slice(0, limit);
        }

        if (json) {
          for (const post of posts) {
            outputJson(post);
          }
          return;
        }

        displayPosts(posts, 0);
      },
    );

  // ── schedule edit ──────────────────────────────────────────────
  schedule
    .command("edit")
    .description("Edit a scheduled post")
    .argument("[index]", "Post number from list (1-indexed)")
    .action(async (indexArg?: string) => {
      const profile = program.opts().profile;
      const allPosts = await listScheduledPosts(profile);

      const rl = createInterface({ input: stdin, output: stderr });
      try {
        let post: ScheduledPost | null;

        if (indexArg) {
          const idx = parseInt(indexArg, 10);
          if (isNaN(idx) || idx < 1 || idx > allPosts.length) {
            console.error(
              `Invalid index. Use a number between 1 and ${allPosts.length}.`,
            );
            process.exit(1);
          }
          post = allPosts[idx - 1];
        } else {
          post = await selectPost(rl, allPosts);
          if (!post) return;
        }

        // Display current state
        console.log(`\n${chalk.blue("Text:")} ${post.text}`);
        console.log(
          `${chalk.blue("Scheduled:")} ${formatLocalDateTime(post.scheduledAt)}`,
        );

        // Ask what to edit
        const choice = await rl.question(
          "\nEdit (t)ext, (d)ate/time, or (b)oth? ",
        );
        const c = choice.trim().toLowerCase();

        if (c === "t" || c === "text" || c === "b" || c === "both") {
          // Edit text
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const newText = await rl.question("New text: ");
            if (!newText.trim()) {
              console.error("Text cannot be empty.");
              continue;
            }
            const len = graphemeLength(newText);
            if (len > 300) {
              console.error(
                `Text is ${len} characters (max 300). Please shorten it.`,
              );
              continue;
            }
            post.text = newText;
            break;
          }
        }

        if (c === "d" || c === "date" || c === "time" || c === "b" || c === "both") {
          // Edit date/time
          post.scheduledAt = await promptDateTime(rl);
        }

        await updateScheduledPost(post, profile);
        console.error(`Scheduled post ${chalk.blue(post.id)} updated.`);
      } finally {
        rl.close();
      }
    });

  // ── schedule delete ────────────────────────────────────────────
  schedule
    .command("delete")
    .alias("rm")
    .description("Delete a scheduled post")
    .argument("[index]", "Post number from list (1-indexed)")
    .action(async (indexArg?: string) => {
      const profile = program.opts().profile;
      const allPosts = await listScheduledPosts(profile);

      const rl = createInterface({ input: stdin, output: stderr });
      try {
        let post: ScheduledPost | null;

        if (indexArg) {
          const idx = parseInt(indexArg, 10);
          if (isNaN(idx) || idx < 1 || idx > allPosts.length) {
            console.error(
              `Invalid index. Use a number between 1 and ${allPosts.length}.`,
            );
            process.exit(1);
          }
          post = allPosts[idx - 1];
        } else {
          post = await selectPost(rl, allPosts);
          if (!post) return;
        }

        // Show what will be deleted
        const preview =
          post.text.length > 60 ? post.text.slice(0, 57) + "..." : post.text;
        console.log(
          `\n${preview} ${chalk.dim(`(${formatLocalDateTime(post.scheduledAt)})`)}`,
        );

        // Confirm deletion
        const confirm = await rl.question("Are you sure (y/N)? ");
        if (confirm.trim().toLowerCase() !== "y") {
          console.error("Cancelled.");
          return;
        }

        // Offer to save as draft
        const saveDraftAnswer = await rl.question(
          "Would you like to save the post as a draft? (Y/n) ",
        );
        if (saveDraftAnswer.trim().toLowerCase() !== "n") {
          const draft = await saveDraft(
            {
              type: "post",
              text: post.text,
              reason: "manual",
              images: post.images,
              imageAlts: post.imageAlts,
              video: post.video,
              videoAlt: post.videoAlt,
            },
            profile,
          );
          console.error(`Draft saved: ${chalk.blue(draft.id)}`);
        }

        await deleteScheduledPost(post.id, profile);
        console.error("Scheduled post deleted.");
      } finally {
        rl.close();
      }
    });

  // ── schedule run ───────────────────────────────────────────────
  schedule
    .command("run")
    .description("Post all scheduled posts that are due (for use with cron)")
    .action(async () => {
      await postDueItems(program);
    });
}
