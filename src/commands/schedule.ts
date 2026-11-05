import chalk from "chalk";
import { resolve } from "node:path";
import { stdin, stderr } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { Cron } from "croner";
import { getClient, isJson } from "@/index";
import {
  saveScheduledPost,
  listScheduledPosts,
  deleteScheduledPost,
  claimPath,
  claimScheduledPost,
  claimedPosts,
  finishScheduledPost,
  releaseScheduledPost,
  rescheduleScheduledPost,
  type ClaimedPost,
  updateScheduledPost,
  isScheduledDirEmpty,
} from "@/scheduled";
import { saveDraft } from "@/drafts";
import { createPost } from "@/commands/post";
import { graphemeLength } from "@/lib/split-thread";
import { promptDateTime, formatLocalDateTime } from "@/lib/date-prompt";
import { outputJson } from "@/lib/format";
import {
  enableScheduler,
  disableScheduler,
  getSchedulerStatus,
  uninstallScheduler,
} from "@/lib/scheduler";
import {
  buildRRule,
  nextOccurrence,
  parseCount,
  parseRRuleFrequency,
  formatFrequency,
  VALID_FREQUENCIES,
} from "@/lib/recurrence";
import type { RecurrenceFrequency } from "@/lib/recurrence";
import type { ScheduledPost } from "@/lib/types";

const PAGE_SIZE = 5;

/**
 * Find all scheduled posts that are due and publish them.
 * Returns the number of successfully posted items.
 */
/** A recurring post as it'll be for its next run, if it has one. */
function nextRun(post: ScheduledPost): ScheduledPost | undefined {
  if (!post.rrule || (post.remainingCount != null && post.remainingCount <= 1)) return undefined;
  const freq = parseRRuleFrequency(post.rrule);
  const next = freq && nextOccurrence(new Date(post.scheduledAt), freq);
  if (!freq || !next) return undefined;
  if (post.remainingCount == null) return { ...post, scheduledAt: next.toISOString() };
  const remainingCount = post.remainingCount - 1;
  return { ...post, scheduledAt: next.toISOString(), remainingCount, rrule: buildRRule(freq, remainingCount) };
}

function warnAboutClaim({ id, path, text, rrule }: ClaimedPost): void {
  if (text === undefined) {
    console.error(`${path} holds a post that may not have gone out, and it can't be read. Fix it, or delete it.`);
    return;
  }
  const line = text.split("\n")[0];
  console.error(`A run may have stopped while sending ${id} ("${line}"), so it may have gone out. Check your Bluesky profile, then delete ${path}, or rename it to ${id}.json to send it.`);
  if (rrule) console.error("It repeats: deleting it ends the series. To keep the series without sending this one again, change its scheduledAt to the next date first.");
}

async function postDueItems(program: Command): Promise<number> {
  const profile = program.opts().profile;
  for (const claim of await claimedPosts(profile)) if (claim.stale) warnAboutClaim(claim);
  const posts = await listScheduledPosts(profile);
  const due = posts.filter((p) => new Date(p.scheduledAt) <= new Date());

  if (due.length === 0) return 0;

  const agent = await getClient(program);
  let posted = 0;

  for (const listed of due) {
    let post: ScheduledPost | undefined;
    try {
      post = await claimScheduledPost(listed, profile);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Couldn't take ${listed.id} from the queue, so it wasn't sent: ${msg}`);
      continue;
    }
    if (!post) continue;

    let result;
    try {
      result = await createPost(agent, post.text, {
        images: post.images,
        imageAlts: post.imageAlts,
        video: post.video,
        videoAlt: post.videoAlt,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to post ${post.id}: ${msg}`);
      const { id } = post;
      await releaseScheduledPost(id, profile).catch((back: unknown) => {
        const reason = back instanceof Error ? back.message : String(back);
        console.error(`Couldn't put ${id} back in the queue: ${reason}. It wasn't sent: rename ${claimPath(id, profile)} to ${id}.json to send it.`);
      });
      continue;
    }
    console.log(result.uri);
    posted++;

    const next = nextRun(post);
    try {
      if (next) await rescheduleScheduledPost(next, profile);
      else await finishScheduledPost(post.id, profile);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        next
          ? `Posted ${post.id}, but couldn't save its next run (${next.scheduledAt}): ${msg}. The series has stopped: set scheduledAt to that date in ${claimPath(post.id, profile)}, then rename it to ${post.id}.json.`
          : `Posted ${post.id}, but couldn't clear it from the queue: ${msg}. It won't send again.`,
      );
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
    if (post.rrule) {
      const freq = parseRRuleFrequency(post.rrule);
      if (freq) {
        const suffix = post.remainingCount != null
          ? ` (${post.remainingCount} remaining)`
          : " (forever)";
        console.log(
          `   ${chalk.dim(`Repeats ${formatFrequency(freq)}${suffix}`)}`,
        );
      }
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
    .option("--repeat <frequency>", "Repeat: hourly, daily, fortnightly, monthly, annually")
    .option("--times <count>", "Number of times to repeat (number or word, e.g. '5' or 'three')")
    .action(
      async (
        textParts: string[],
        opts: {
          stdin?: boolean;
          image?: string[];
          imageAlt?: string[];
          video?: string;
          videoAlt?: string;
          repeat?: string;
          times?: string;
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

        // Validate --repeat / --times options
        if (opts.times && !opts.repeat) {
          console.error("Error: --times requires --repeat");
          process.exit(1);
        }

        let rrule: string | undefined;
        let remainingCount: number | undefined;
        let repeatFreq: RecurrenceFrequency | undefined;

        if (opts.repeat) {
          if (!VALID_FREQUENCIES.includes(opts.repeat as RecurrenceFrequency)) {
            console.error(
              `Error: --repeat must be one of: ${VALID_FREQUENCIES.join(", ")}`,
            );
            process.exit(1);
          }
          repeatFreq = opts.repeat as RecurrenceFrequency;
        }

        const wasEmpty = await isScheduledDirEmpty(profile);

        const rl = createInterface({ input: stdin, output: stderr });
        try {
          // If --repeat was given, resolve the optional count
          if (repeatFreq) {
            if (opts.times) {
              const parsed = parseCount(opts.times);
              if (!parsed) {
                console.error(
                  `Error: could not parse "${opts.times}" as a number`,
                );
                process.exit(1);
              }
              remainingCount = parsed;
            } else {
              const answer = await rl.question(
                "How many times? (leave blank for forever) ",
              );
              if (answer.trim()) {
                const parsed = parseCount(answer);
                if (!parsed) {
                  console.error("Could not parse that as a number.");
                  process.exit(1);
                }
                remainingCount = parsed;
              }
              // blank → remainingCount stays undefined → infinite
            }
            rrule = buildRRule(repeatFreq, remainingCount);
          }

          const scheduledAt = await promptDateTime(rl);

          const post = await saveScheduledPost(
            {
              scheduledAt,
              text,
              images: opts.image?.map((p) => resolve(p)),
              imageAlts: opts.imageAlt,
              video: opts.video ? resolve(opts.video) : undefined,
              videoAlt: opts.videoAlt,
              rrule,
              remainingCount,
            },
            profile,
          );

          console.error(
            `Scheduled post saved: ${chalk.blue(post.id)} (${formatLocalDateTime(scheduledAt)})`,
          );
          if (repeatFreq) {
            const countDesc = remainingCount != null
              ? `${remainingCount} times`
              : "forever";
            console.error(
              `  Repeats ${formatFrequency(repeatFreq)}, ${countDesc}`,
            );
          }

          // First-use onboarding: offer to set up the scheduler
          if (wasEmpty && stdin.isTTY) {
            console.error(`
To automate posting, you can:

  Enable the scheduler to run in the background:
    ${chalk.blue("bsky schedule enable")}

  Or run a foreground watcher (stays open in your terminal,
  checks every minute, handles overlapping runs, stops cleanly
  with Ctrl+C, customizable with --interval):
    ${chalk.blue("bsky schedule watch")}
`);
            const answer = await rl.question(
              "Would you like to enable the scheduler now? (Y/n) ",
            );
            if (answer.trim().toLowerCase() !== "n") {
              enableScheduler(1, profile);
              console.error("Scheduler enabled (every 1 minute).");
            } else {
              console.error(
                chalk.dim("You can enable it later with: bsky schedule enable"),
              );
            }
          }
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
        const claims = await claimedPosts(profile);
        for (const { id, path, stale } of claims) {
          console.error(stale ? `${id} may have gone out: a run left ${path} behind, and schedule run says what to do` : `${id} is being sent`);
        }

        if (posts.length === 0) {
          if (!json && claims.length === 0) console.error("No scheduled posts.");
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

        const hasRecurrence = !!post.rrule;
        if (hasRecurrence) {
          const freq = parseRRuleFrequency(post.rrule!);
          if (freq) {
            const suffix = post.remainingCount != null
              ? `(${post.remainingCount} remaining)`
              : "(forever)";
            console.log(
              `${chalk.blue("Repeats:")} ${formatFrequency(freq)} ${suffix}`,
            );
          }
        }

        // Ask what to edit
        const prompt = hasRecurrence
          ? "\nEdit (t)ext, (d)ate/time, (r)ecurrence, or (a)ll? "
          : "\nEdit (t)ext, (d)ate/time, or (b)oth? ";
        const choice = await rl.question(prompt);
        const c = choice.trim().toLowerCase();

        const editAll = c === "a" || c === "all" || c === "b" || c === "both";

        if (c === "t" || c === "text" || editAll) {
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

        if (c === "d" || c === "date" || c === "time" || editAll) {
          // Edit date/time
          post.scheduledAt = await promptDateTime(rl);
        }

        if (c === "r" || c === "recurrence" || editAll) {
          // Edit recurrence
          const freqAnswer = await rl.question(
            `Frequency (${VALID_FREQUENCIES.join(", ")}) or "none" to remove: `,
          );
          const freqTrimmed = freqAnswer.trim().toLowerCase();

          if (freqTrimmed === "none" || freqTrimmed === "remove") {
            delete post.rrule;
            delete post.remainingCount;
          } else if (VALID_FREQUENCIES.includes(freqTrimmed as RecurrenceFrequency)) {
            const countAnswer = await rl.question(
              "How many times? (leave blank for forever) ",
            );
            if (countAnswer.trim()) {
              const count = parseCount(countAnswer);
              if (!count) {
                console.error("Could not parse that as a number. Recurrence unchanged.");
              } else {
                post.rrule = buildRRule(freqTrimmed as RecurrenceFrequency, count);
                post.remainingCount = count;
              }
            } else {
              post.rrule = buildRRule(freqTrimmed as RecurrenceFrequency);
              delete post.remainingCount;
            }
          } else {
            console.error("Invalid frequency. Recurrence unchanged.");
          }
        }

        try {
          await updateScheduledPost(post, profile);
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          console.error("That post is being sent, or has gone, so your changes weren't saved.");
          return;
        }
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

        try {
          await deleteScheduledPost(post.id, profile);
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          console.error("That post is being sent, or has gone, so it wasn't deleted. If sending fails, it goes back in the queue.");
          return;
        }
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

  // ── schedule watch ────────────────────────────────────────────
  schedule
    .command("watch")
    .description("Run a foreground watcher that posts due scheduled items")
    .option("--interval <cron>", "Cron expression for check interval", "* * * * *")
    .action(async (opts: { interval: string }) => {
      console.error("Watching for due scheduled posts...");
      console.error(`Interval: ${opts.interval}`);
      console.error("Press Ctrl+C to stop.\n");

      const job = new Cron(
        opts.interval,
        {
          catch: (err) => console.error(`Scheduled run failed: ${err instanceof Error ? err.message : String(err)}`),
          protect: true,
        },
        async () => {
          const count = await postDueItems(program);
          if (count > 0) {
            console.error(`Posted ${count} item(s).`);
          }
        },
      );

      const shutdown = () => {
        console.error("\nWatcher stopped.");
        job.stop();
        // Leaving mid-send would strand the post. A second Ctrl+C still leaves at once.
        const leave = () => (job.isBusy() ? setTimeout(leave, 100) : process.exit(0));
        leave();
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });

  // ── schedule enable ───────────────────────────────────────────
  schedule
    .command("enable")
    .description("Enable OS-level scheduler for posting due items")
    .option("--interval <minutes>", "Check interval in minutes", "1")
    .action((opts: { interval: string }) => {
      const profile = program.opts().profile;
      const interval = parseInt(opts.interval, 10);
      if (isNaN(interval) || interval < 1) {
        console.error("Error: interval must be a positive integer (minutes)");
        process.exit(1);
      }
      enableScheduler(interval, profile);
      console.error(`Scheduler enabled (every ${interval} minute(s)).`);
      console.error(
        chalk.dim("Disable with: bsky schedule disable"),
      );
      console.error(
        chalk.dim("Remove with:  bsky schedule uninstall"),
      );
    });

  // ── schedule disable ──────────────────────────────────────────
  schedule
    .command("disable")
    .description("Disable the OS-level scheduler (preserves config)")
    .action(() => {
      disableScheduler();
      console.error("Scheduler disabled. Config preserved.");
      console.error(
        chalk.dim("Re-enable with: bsky schedule enable"),
      );
    });

  // ── schedule status ───────────────────────────────────────────
  schedule
    .command("status")
    .description("Show the current scheduler state")
    .action(() => {
      const json = isJson(program);
      const state = getSchedulerStatus();
      if (json) {
        outputJson({ scheduler: state });
      } else {
        console.log(`Scheduler: ${state}`);
      }
    });

  // ── schedule uninstall ────────────────────────────────────────
  schedule
    .command("uninstall")
    .description("Fully remove the OS-level scheduler")
    .action(async () => {
      const status = getSchedulerStatus();
      if (status === "not installed") {
        console.error("Scheduler is not installed.");
        return;
      }

      const rl = createInterface({ input: stdin, output: stderr });
      try {
        const answer = await rl.question(
          "This will permanently remove the scheduler configuration.\nAre you sure? (y/N) ",
        );
        if (answer.trim().toLowerCase() !== "y") {
          console.error("Cancelled.");
          return;
        }
      } finally {
        rl.close();
      }

      uninstallScheduler();
      console.error("Scheduler uninstalled.");
    });
}
