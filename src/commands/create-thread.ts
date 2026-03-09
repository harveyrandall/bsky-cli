import { stdin, stderr } from "node:process";
import { createInterface } from "node:readline/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import chalk from "chalk";
import type { Command } from "commander";
import type { ComAtprotoRepoStrongRef } from "@atproto/api";
import { getClient, isJson } from "@/index";
import { createPost, isNetworkError } from "@/commands/post";
import {
  splitThread,
  graphemeLength,
  isEdgeCaseLength,
  trimSuggestions,
} from "@/lib/split-thread";
import type { ThreadPost } from "@/lib/split-thread";
import { saveDraft } from "@/drafts";
import { outputJson } from "@/lib/format";
import type { Draft, ThreadDraftPost } from "@/lib/types";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

interface MediaOpts {
  images?: string[];
  imageAlts?: string[];
  video?: string;
  videoAlt?: string;
  links?: string[];
  mediaAll?: boolean;
}

interface ThreadPostWithMedia extends ThreadPost {
  images?: string[];
  imageAlts?: string[];
  video?: string;
  videoAlt?: string;
  link?: string;
}

function distributeMedia(
  posts: ThreadPost[],
  media: MediaOpts,
): ThreadPostWithMedia[] {
  return posts.map((post, i) => {
    const p: ThreadPostWithMedia = { ...post };

    if (media.mediaAll) {
      p.images = media.images;
      p.imageAlts = media.imageAlts;
      p.video = media.video;
      p.videoAlt = media.videoAlt;
      if (media.links && media.links.length > 0) {
        p.link = media.links[0];
      }
      return p;
    }

    // Images: distribute 1:1 by index
    if (media.images && i < media.images.length) {
      p.images = [media.images[i]];
      if (media.imageAlts && i < media.imageAlts.length) {
        p.imageAlts = [media.imageAlts[i]];
      }
    }

    // Video: first post only
    if (i === 0 && media.video) {
      p.video = media.video;
      p.videoAlt = media.videoAlt;
    }

    // Links: distribute 1:1 by index
    if (media.links && i < media.links.length) {
      p.link = media.links[i];
    }

    return p;
  });
}

function renderPreview(posts: ThreadPostWithMedia[]): void {
  for (const post of posts) {
    const chars = graphemeLength(post.text);
    console.error(
      `${chalk.blue(`--- Post ${post.index + 1}/${posts.length}`)} ${chalk.dim(`(${chars} chars)`)} ${chalk.blue("---")}`,
    );
    console.error(post.text);
    if (post.images?.length) {
      console.error(
        `  ${chalk.dim(`📷 ${post.images.length} image(s): ${post.images.map((p) => p.split("/").pop()).join(", ")}`)}`,
      );
    }
    if (post.video) {
      console.error(`  ${chalk.dim(`🎬 Video: ${post.video.split("/").pop()}`)}`);
    }
    if (post.link) {
      console.error(`  ${chalk.dim(`🔗 Link: ${post.link}`)}`);
    }
    console.error();
  }
}

async function editPost(
  post: ThreadPostWithMedia,
): Promise<ThreadPostWithMedia> {
  const editor = process.env.EDITOR || "vi";
  const tmpPath = join(tmpdir(), `bsky-thread-${randomBytes(4).toString("hex")}.txt`);
  await writeFile(tmpPath, post.text, "utf-8");
  spawnSync(editor, [tmpPath], { stdio: "inherit" });
  const newText = (await readFile(tmpPath, "utf-8")).trimEnd();
  return { ...post, text: newText };
}

async function interactivePreview(
  posts: ThreadPostWithMedia[],
  profile: string | undefined,
  originalText: string,
): Promise<ThreadPostWithMedia[] | "quit"> {
  const rl = createInterface({ input: stdin, output: stderr });

  let current = [...posts];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    renderPreview(current);
    console.error(
      chalk.dim("[c]onfirm  [e]dit <N>  [d]elete <N>  [q]uit"),
    );

    let answer: string;
    try {
      answer = await rl.question("> ");
    } catch {
      rl.close();
      return "quit";
    }

    const cmd = answer.trim().toLowerCase();

    if (cmd === "c" || cmd === "confirm") {
      rl.close();
      return current;
    }

    if (cmd === "q" || cmd === "quit") {
      const save = await rl.question("Save as draft? [Y/n] ");
      if (save.trim().toLowerCase() !== "n") {
        const draft = await saveDraft(
          {
            type: "thread",
            text: originalText,
            reason: "manual",
            posts: current.map((p) => ({
              text: p.text,
              images: p.images,
              imageAlts: p.imageAlts,
              video: p.video,
              videoAlt: p.videoAlt,
              link: p.link,
            })),
          },
          profile,
        );
        console.error(`Draft saved: ${draft.id}`);
      }
      rl.close();
      return "quit";
    }

    const editMatch = cmd.match(/^e(?:dit)?\s+(\d+)$/);
    if (editMatch) {
      const n = parseInt(editMatch[1], 10);
      if (n < 1 || n > current.length) {
        console.error(chalk.red(`Invalid post number: ${n}`));
        continue;
      }
      current[n - 1] = await editPost(current[n - 1]);
      continue;
    }

    const deleteMatch = cmd.match(/^d(?:elete)?\s+(\d+)$/);
    if (deleteMatch) {
      const n = parseInt(deleteMatch[1], 10);
      if (n < 1 || n > current.length) {
        console.error(chalk.red(`Invalid post number: ${n}`));
        continue;
      }
      if (current.length <= 1) {
        console.error(chalk.red("Cannot delete the only post."));
        continue;
      }
      const confirm = await rl.question(`Delete post ${n}? [y/N] `);
      if (confirm.trim().toLowerCase() === "y") {
        current.splice(n - 1, 1);
        // Re-index
        current = current.map((p, i) => ({ ...p, index: i }));
      }
      continue;
    }

    console.error(chalk.red("Unknown command. Use [c]onfirm, [e]dit <N>, [d]elete <N>, or [q]uit."));
  }
}

async function postThread(
  agent: Awaited<ReturnType<typeof getClient>>,
  posts: ThreadPostWithMedia[],
  opts: {
    replyTo?: ComAtprotoRepoStrongRef.Main;
    replyRoot?: ComAtprotoRepoStrongRef.Main;
    quote?: ComAtprotoRepoStrongRef.Main;
  },
  profile: string | undefined,
  originalText: string,
): Promise<string[]> {
  const uris: string[] = [];
  let rootRef: ComAtprotoRepoStrongRef.Main | undefined = opts.replyRoot;
  let parentRef: ComAtprotoRepoStrongRef.Main | undefined = opts.replyTo;

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];

    try {
      const result = await createPost(agent, post.text, {
        reply: i === 0 ? opts.replyTo : parentRef,
        replyRoot: i === 0 ? opts.replyRoot : rootRef,
        quote: i === 0 ? opts.quote : undefined,
        images: post.images,
        imageAlts: post.imageAlts,
        video: post.video,
        videoAlt: post.videoAlt,
      });

      uris.push(result.uri);

      if (i === 0 && !rootRef) {
        rootRef = { uri: result.uri, cid: result.cid };
      }
      parentRef = { uri: result.uri, cid: result.cid };
    } catch (err: unknown) {
      // Partial failure: save remaining posts as draft
      const remaining = posts.slice(i);
      const reason = isNetworkError(err) ? "network" : "manual";

      if (uris.length > 0) {
        console.error(
          chalk.yellow(`\nPosted ${uris.length}/${posts.length} before failure:`),
        );
        for (const uri of uris) console.error(`  ${uri}`);
      }

      const draft = await saveDraft(
        {
          type: "thread",
          text: originalText,
          reason,
          replyUri: parentRef?.uri,
          posts: remaining.map((p) => ({
            text: p.text,
            images: p.images,
            imageAlts: p.imageAlts,
            video: p.video,
            videoAlt: p.videoAlt,
            link: p.link,
          })),
        },
        profile,
      );

      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        chalk.red(`\nFailed at post ${i + 1}/${posts.length}: ${msg}`),
      );
      console.error(`Remaining ${remaining.length} post(s) saved as draft: ${draft.id}`);

      if (reason === "network") {
        console.error("They will be sent automatically next time you're online.");
      }

      process.exit(1);
    }
  }

  return uris;
}

export function registerCreateThread(program: Command): void {
  program
    .command("create-thread")
    .description("Create a thread from long text, splitting at sentence boundaries")
    .argument("[text...]", "Thread text")
    .option("--stdin", "Read text from stdin")
    .option("--draft", "Save as draft instead of publishing")
    .option("--thread-label", "Add 🧵 1/N label to each post")
    .option("--prepend-thread-label", "Put label at start (default: append)")
    .option("-i, --image <files...>", "Image files distributed across posts")
    .option("--image-alt <alts...>", "Alt text for images")
    .option("--video <file>", "Video file (first post only)")
    .option("--video-alt <alt>", "Alt text for video")
    .option("--link <urls...>", "Link embeds distributed across posts")
    .option("--media-all", "Attach same media to every post")
    .option("--reply-to <uri>", "First post replies to this URI")
    .option("--quote <uri>", "First post quotes this URI")
    .option("--no-preview", "Skip interactive preview")
    .option("--skip-validation", "Skip edge-case validation for 301-375 char text")
    .action(
      async (
        textParts: string[],
        opts: {
          stdin?: boolean;
          draft?: boolean;
          threadLabel?: boolean;
          prependThreadLabel?: boolean;
          image?: string[];
          imageAlt?: string[];
          video?: string;
          videoAlt?: string;
          link?: string[];
          mediaAll?: boolean;
          replyTo?: string;
          quote?: string;
          preview?: boolean;
          skipValidation?: boolean;
        },
      ) => {
        let text = textParts.join(" ");
        if (opts.stdin) {
          text = await readStdin();
        }
        text = text.trim();

        if (!text) {
          console.error("Error: thread text is required");
          process.exit(1);
        }

        const profile = program.opts().profile;
        const json = isJson(program);
        const len = graphemeLength(text);

        // Single post: delegate
        if (len <= 300) {
          if (opts.draft) {
            const draft = await saveDraft(
              { type: "post", text, reason: "manual" },
              profile,
            );
            console.error(`Text fits in one post. Draft saved: ${draft.id}`);
            return;
          }
          const agent = await getClient(program);
          const result = await createPost(agent, text, {
            images: opts.image,
            imageAlts: opts.imageAlt,
            video: opts.video,
            videoAlt: opts.videoAlt,
          });
          if (json) {
            outputJson({ uris: [result.uri] });
          } else {
            console.log(result.uri);
          }
          return;
        }

        // Edge case: 301-375 chars
        if (isEdgeCaseLength(text) && !opts.skipValidation) {
          // Show what the split would look like
          const edgePosts = splitThread(text, {
            threadLabel: opts.threadLabel,
            threadLabelPosition: opts.prependThreadLabel ? "prepend" : "append",
          });

          console.error(
            chalk.yellow(`Thread text is ${len} characters — too long for one post, short for a thread.\n`),
          );
          console.error("The thread would be split as:");
          for (const ep of edgePosts) {
            const chars = graphemeLength(ep.text);
            console.error(
              `${chalk.blue(`--- Post ${ep.index + 1}/${edgePosts.length}`)} ${chalk.dim(`(${chars} chars)`)} ${chalk.blue("---")}`,
            );
            console.error(ep.text);
            console.error();
          }

          // Ask if user wants to post anyway (TTY only)
          if (stdin.isTTY) {
            const rl = createInterface({ input: stdin, output: stderr });
            const confirm = await rl.question("Post this thread anyway? [y/N] ");
            rl.close();

            if (confirm.trim().toLowerCase() === "y") {
              // Fall through to normal thread posting
              // (handled below after this block)
            } else {
              // Declined — save as draft and show trim suggestions
              const draft = await saveDraft(
                { type: "post", text, reason: "length" },
                profile,
              );

              const over = len - 300;
              console.error(`Saved as draft: ${chalk.blue(draft.id)}\n`);

              const suggestions = trimSuggestions(text);
              if (suggestions.length > 0) {
                console.error(`Trim suggestions (need to remove ${over} characters):`);
                for (let i = 0; i < suggestions.length; i++) {
                  console.error(
                    `  ${i + 1}. End after "${suggestions[i].preview}" ${chalk.dim(`(cuts ${suggestions[i].charsToRemove} chars)`)}`,
                  );
                }
                console.error();
              }

              // Offer to accept suggestion
              if (suggestions.length > 0) {
                const rl2 = createInterface({ input: stdin, output: stderr });
                const answer = await rl2.question(
                  "Accept a suggestion? [1-" + suggestions.length + "/n] ",
                );
                rl2.close();

                const choice = parseInt(answer.trim(), 10);
                if (choice >= 1 && choice <= suggestions.length) {
                  const trimmedText = text
                    .trim()
                    .slice(0, text.trim().length - suggestions[choice - 1].charsToRemove);

                  if (opts.draft) {
                    console.error(`Trimmed text saved in draft ${draft.id}`);
                    return;
                  }

                  const agent = await getClient(program);
                  const result = await createPost(agent, trimmedText, {
                    images: opts.image,
                    imageAlts: opts.imageAlt,
                    video: opts.video,
                    videoAlt: opts.videoAlt,
                  });

                  if (json) {
                    outputJson({ uris: [result.uri] });
                  } else {
                    console.log(result.uri);
                  }

                  const { deleteDraft } = await import("@/drafts");
                  await deleteDraft(draft.id, profile);
                  console.error("Draft deleted after successful post.");
                  return;
                }
              }

              console.error(
                `Tip: pipe through 'llm' to auto-trim:\n  bsky drafts show ${draft.id.slice(0, 7)} | llm "shorten to under 300 chars" | bsky post`,
              );
              return;
            }
          } else {
            // Non-TTY: save as draft, show suggestions
            const draft = await saveDraft(
              { type: "post", text, reason: "length" },
              profile,
            );

            const over = len - 300;
            console.error(`Saved as draft: ${chalk.blue(draft.id)}\n`);

            const suggestions = trimSuggestions(text);
            if (suggestions.length > 0) {
              console.error(`Trim suggestions (need to remove ${over} characters):`);
              for (let i = 0; i < suggestions.length; i++) {
                console.error(
                  `  ${i + 1}. End after "${suggestions[i].preview}" ${chalk.dim(`(cuts ${suggestions[i].charsToRemove} chars)`)}`,
                );
              }
              console.error();
            }

            console.error(
              `Tip: pipe through 'llm' to auto-trim:\n  bsky drafts show ${draft.id.slice(0, 7)} | llm "shorten to under 300 chars" | bsky post`,
            );
            console.error(
              `Or use --skip-validation to post the thread as-is.`,
            );
            return;
          }
        }

        // Normal thread: split text
        const splitPosts = splitThread(text, {
          threadLabel: opts.threadLabel,
          threadLabelPosition: opts.prependThreadLabel ? "prepend" : "append",
        });

        // Warn about extra images
        if (
          opts.image &&
          !opts.mediaAll &&
          opts.image.length > splitPosts.length
        ) {
          console.error(
            chalk.yellow(
              `Warning: ${opts.image.length} images for ${splitPosts.length} posts — extra images will be dropped.`,
            ),
          );
        }

        // Distribute media
        let postsWithMedia = distributeMedia(splitPosts, {
          images: opts.image,
          imageAlts: opts.imageAlt,
          video: opts.video,
          videoAlt: opts.videoAlt,
          links: opts.link,
          mediaAll: opts.mediaAll,
        });

        // --draft: save and exit
        if (opts.draft) {
          const draft = await saveDraft(
            {
              type: "thread",
              text,
              reason: "manual",
              posts: postsWithMedia.map((p) => ({
                text: p.text,
                images: p.images,
                imageAlts: p.imageAlts,
                video: p.video,
                videoAlt: p.videoAlt,
                link: p.link,
              })),
            },
            profile,
          );
          console.error(`Thread draft saved: ${draft.id} (${postsWithMedia.length} posts)`);
          return;
        }

        // Interactive preview (TTY + --preview enabled)
        if (opts.preview !== false && stdin.isTTY) {
          const result = await interactivePreview(
            postsWithMedia,
            profile,
            text,
          );
          if (result === "quit") return;
          postsWithMedia = result;
        } else if (opts.preview !== false) {
          // Non-TTY: just render preview
          renderPreview(postsWithMedia);
        }

        // Resolve reply-to / quote refs
        const agent = await getClient(program);
        let replyRef: ComAtprotoRepoStrongRef.Main | undefined;
        let rootRef: ComAtprotoRepoStrongRef.Main | undefined;
        let quoteRef: ComAtprotoRepoStrongRef.Main | undefined;

        if (opts.replyTo) {
          const parts = opts.replyTo.split("/");
          const rkey = parts[parts.length - 1];
          const collection = parts[parts.length - 2];
          const did = parts[2];

          const record = await agent.com.atproto.repo.getRecord({
            repo: did,
            collection,
            rkey,
          });

          replyRef = { uri: record.data.uri, cid: record.data.cid! };
          const parentValue = record.data.value as { reply?: { root: ComAtprotoRepoStrongRef.Main } };
          rootRef = parentValue.reply?.root ?? replyRef;
        }

        if (opts.quote) {
          const parts = opts.quote.split("/");
          const rkey = parts[parts.length - 1];
          const collection = parts[parts.length - 2];
          const did = parts[2];

          const record = await agent.com.atproto.repo.getRecord({
            repo: did,
            collection,
            rkey,
          });

          quoteRef = { uri: record.data.uri, cid: record.data.cid! };
        }

        // SIGINT trap during posting
        let sigintHandler: (() => void) | undefined;
        let postingIndex = 0;

        if (stdin.isTTY) {
          sigintHandler = () => {
            process.once("SIGINT", () => process.exit(130));
            (async () => {
              const remaining = postsWithMedia.slice(postingIndex);
              const draft = await saveDraft(
                {
                  type: "thread",
                  text,
                  reason: "manual",
                  posts: remaining.map((p) => ({
                    text: p.text,
                    images: p.images,
                    imageAlts: p.imageAlts,
                    video: p.video,
                    videoAlt: p.videoAlt,
                    link: p.link,
                  })),
                },
                profile,
              );
              console.error(`\nRemaining posts saved as draft: ${draft.id}`);
              process.exit(0);
            })();
          };
          process.on("SIGINT", sigintHandler);
        }

        try {
          const uris = await postThread(
            agent,
            postsWithMedia,
            { replyTo: replyRef, replyRoot: rootRef, quote: quoteRef },
            profile,
            text,
          );

          if (json) {
            outputJson({ uris });
          } else {
            for (const uri of uris) console.log(uri);
          }
        } finally {
          if (sigintHandler) {
            process.removeListener("SIGINT", sigintHandler);
          }
        }
      },
    );
}
