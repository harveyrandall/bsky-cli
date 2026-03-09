import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { stdin, stderr } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import type {
  AppBskyFeedPost,
  AppBskyEmbedImages,
  AppBskyEmbedVideo,
  AppBskyEmbedExternal,
  AppBskyEmbedRecord,
  AppBskyRichtextFacet,
  ComAtprotoRepoStrongRef,
} from "@atproto/api";
import { load as cheerioLoad } from "cheerio";
import { getClient, isJson } from "@/index";
import { extractLinks, extractMentions, extractTags } from "@/lib/extract";
import { saveDraft } from "@/drafts";
import type { Draft } from "@/lib/types";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function detectMimeType(data: Uint8Array): string {
  // Check magic bytes for common formats
  if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  )
    return "image/png";
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46)
    return "image/gif";
  if (
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46
  )
    return "image/webp";
  // Video formats
  if (data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79)
    return "video/mp4";
  return "application/octet-stream";
}

async function buildFacets(
  agent: Awaited<ReturnType<typeof getClient>>,
  text: string,
): Promise<AppBskyRichtextFacet.Main[]> {
  const facets: AppBskyRichtextFacet.Main[] = [];

  for (const entry of extractLinks(text)) {
    facets.push({
      index: { byteStart: entry.start, byteEnd: entry.end },
      features: [
        { $type: "app.bsky.richtext.facet#link", uri: entry.text },
      ],
    });
  }

  for (const entry of extractMentions(text)) {
    try {
      const profile = await agent.getProfile({ actor: entry.text });
      facets.push({
        index: { byteStart: entry.start, byteEnd: entry.end },
        features: [
          { $type: "app.bsky.richtext.facet#mention", did: profile.data.did },
        ],
      });
    } catch {
      // Skip unresolvable mentions
    }
  }

  for (const entry of extractTags(text)) {
    facets.push({
      index: { byteStart: entry.start, byteEnd: entry.end },
      features: [
        { $type: "app.bsky.richtext.facet#tag", tag: entry.text },
      ],
    });
  }

  return facets;
}

async function fetchLinkCard(
  agent: Awaited<ReturnType<typeof getClient>>,
  url: string,
): Promise<AppBskyEmbedExternal.Main | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const html = await resp.text();
    const $ = cheerioLoad(html);

    let title = $("title").text();
    let description =
      $('meta[property="description"]').attr("content") ?? "";
    const imgURL = $('meta[property="og:image"]').attr("content");

    if (!title) title = $('meta[property="og:title"]').attr("content") ?? url;
    if (!description)
      description =
        $('meta[property="og:description"]').attr("content") ?? url;

    const external: AppBskyEmbedExternal.External = {
      uri: url,
      title,
      description,
    };

    if (imgURL) {
      try {
        const imgResp = await fetch(imgURL);
        if (imgResp.ok) {
          const imgData = new Uint8Array(await imgResp.arrayBuffer());
          const uploadResp = await agent.uploadBlob(imgData, {
            encoding: detectMimeType(imgData),
          });
          external.thumb = uploadResp.data.blob;
        }
      } catch {
        // Skip thumbnail on failure
      }
    }

    return { $type: "app.bsky.embed.external", external };
  } catch {
    return null;
  }
}

export async function createPost(
  agent: Awaited<ReturnType<typeof getClient>>,
  text: string,
  opts: {
    reply?: ComAtprotoRepoStrongRef.Main;
    replyRoot?: ComAtprotoRepoStrongRef.Main;
    quote?: ComAtprotoRepoStrongRef.Main;
    images?: string[];
    imageAlts?: string[];
    video?: string;
    videoAlt?: string;
  },
): Promise<{ uri: string; cid: string }> {
  const facets = await buildFacets(agent, text);

  const post: AppBskyFeedPost.Record = {
    $type: "app.bsky.feed.post",
    text,
    createdAt: new Date().toISOString(),
    facets: facets.length > 0 ? facets : undefined,
  };

  // Reply
  if (opts.reply) {
    post.reply = {
      root: opts.replyRoot ?? opts.reply,
      parent: opts.reply,
    };
  }

  // Embed: images
  if (opts.images && opts.images.length > 0) {
    const images: AppBskyEmbedImages.Image[] = [];
    for (let i = 0; i < opts.images.length; i++) {
      const data = await readFile(opts.images[i]);
      const uploadResp = await agent.uploadBlob(data, {
        encoding: detectMimeType(data),
      });
      images.push({
        alt: opts.imageAlts?.[i] ?? basename(opts.images[i]),
        image: uploadResp.data.blob,
      });
    }
    (post as Record<string, unknown>).embed = { $type: "app.bsky.embed.images", images };
  }

  // Embed: video
  if (opts.video) {
    const data = await readFile(opts.video);
    const uploadResp = await agent.uploadBlob(data, {
      encoding: detectMimeType(data),
    });
    (post as Record<string, unknown>).embed = {
      $type: "app.bsky.embed.video",
      video: uploadResp.data.blob,
      alt: opts.videoAlt ?? basename(opts.video),
    };
  }

  // Embed: quote
  if (opts.quote) {
    (post as Record<string, unknown>).embed = {
      $type: "app.bsky.embed.record",
      record: opts.quote,
    };
  }

  // Embed: link card (first link, if no other embed)
  if (!post.embed) {
    const links = extractLinks(text);
    if (links.length > 0) {
      const card = await fetchLinkCard(agent, links[0].text);
      if (card) (post as Record<string, unknown>).embed = card;
    }
  }

  const resp = await agent.post(post);
  return { uri: resp.uri, cid: resp.cid };
}

export function isNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : "";
  const cause = err instanceof Error ? err.cause : undefined;
  const causeMsg = cause instanceof Error ? cause.message : "";

  return (
    msg.includes("fetch failed") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("ETIMEDOUT") ||
    causeMsg.includes("fetch failed") ||
    causeMsg.includes("ECONNREFUSED") ||
    causeMsg.includes("ENOTFOUND")
  );
}

export function isLengthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : "";
  return msg.includes("must not be longer than") || msg.includes("InvalidRecord");
}

async function executeOrDraft(
  program: Command,
  draftData: Omit<Draft, "id" | "createdAt" | "reason">,
  opts: { draft?: boolean },
  execute: () => Promise<{ uri: string; cid: string }>,
): Promise<void> {
  const profile = program.opts().profile;

  if (opts.draft) {
    const draft = await saveDraft({ ...draftData, reason: "manual" }, profile);
    console.error(`Draft saved: ${draft.id}`);
    return;
  }

  // SIGINT trap — interactive only
  let sigintHandler: (() => void) | undefined;

  if (stdin.isTTY) {
    sigintHandler = () => {
      // Second Ctrl+C during prompt exits immediately
      process.once("SIGINT", () => process.exit(130));

      (async () => {
        const rl = createInterface({ input: stdin, output: stderr });
        try {
          const answer = await rl.question("\nSave as draft? [Y/n] ");
          rl.close();
          if (answer.trim().toLowerCase() !== "n") {
            const draft = await saveDraft(
              { ...draftData, reason: "manual" },
              profile,
            );
            console.error(`Draft saved: ${draft.id}`);
          }
        } catch {
          // readline closed by second SIGINT
        }
        process.exit(0);
      })();
    };
    process.on("SIGINT", sigintHandler);
  }

  try {
    const result = await execute();
    console.log(result.uri);
  } catch (err: unknown) {
    if (isLengthError(err)) {
      const draft = await saveDraft({ ...draftData, reason: "length" }, profile);
      console.error(`Post exceeds character limit. Saved as draft: ${draft.id}`);
      process.exit(1);
    }

    if (isNetworkError(err)) {
      const draft = await saveDraft({ ...draftData, reason: "network" }, profile);
      console.error(`Network error. Post saved as draft: ${draft.id}`);
      console.error("It will be sent automatically next time you're online.");
      process.exit(1);
    }

    throw err;
  } finally {
    if (sigintHandler) {
      process.removeListener("SIGINT", sigintHandler);
    }
  }
}

export function registerPost(program: Command): void {
  program
    .command("post")
    .description("Create a new post")
    .argument("[text...]", "Post text")
    .option("--stdin", "Read text from stdin")
    .option("--draft", "Save as draft instead of publishing")
    .option("-i, --image <files...>", "Image files to attach")
    .option("--image-alt <alts...>", "Alt text for images")
    .option("--video <file>", "Video file to attach")
    .option("--video-alt <alt>", "Alt text for video")
    .action(
      async (
        textParts: string[],
        opts: {
          stdin?: boolean;
          draft?: boolean;
          image?: string[];
          imageAlt?: string[];
          video?: string;
          videoAlt?: string;
        },
      ) => {
        let text = textParts.join(" ");
        if (opts.stdin) {
          text = await readStdin();
        }
        if (!text.trim()) {
          console.error("Error: post text is required");
          process.exit(1);
        }

        const draftData: Omit<Draft, "id" | "createdAt" | "reason"> = {
          type: "post",
          text,
          images: opts.image?.map((p) => resolve(p)),
          imageAlts: opts.imageAlt,
          video: opts.video ? resolve(opts.video) : undefined,
          videoAlt: opts.videoAlt,
        };

        const agent = opts.draft ? undefined : await getClient(program);

        await executeOrDraft(program, draftData, opts, async () => {
          return createPost(agent!, text, {
            images: opts.image,
            imageAlts: opts.imageAlt,
            video: opts.video,
            videoAlt: opts.videoAlt,
          });
        });
      },
    );
}

export function registerReply(program: Command): void {
  program
    .command("reply")
    .description("Reply to a post")
    .argument("<uri>", "URI of the post to reply to")
    .argument("<text...>", "Reply text")
    .option("--draft", "Save as draft instead of publishing")
    .action(async (uri: string, textParts: string[], opts: { draft?: boolean }) => {
      const text = textParts.join(" ");

      const draftData: Omit<Draft, "id" | "createdAt" | "reason"> = {
        type: "reply",
        text,
        replyUri: uri,
      };

      if (opts.draft) {
        await executeOrDraft(program, draftData, opts, async () => ({ uri: "", cid: "" }));
        return;
      }

      const agent = await getClient(program);

      // Fetch parent post
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

      const parent: ComAtprotoRepoStrongRef.Main = {
        uri: record.data.uri,
        cid: record.data.cid!,
      };

      // Check if parent is itself a reply (to get the root)
      const parentPost = record.data.value as AppBskyFeedPost.Record;
      const root =
        parentPost.reply?.root ??
        parent;

      await executeOrDraft(program, draftData, opts, async () => {
        return createPost(agent, text, {
          reply: parent,
          replyRoot: root as ComAtprotoRepoStrongRef.Main,
        });
      });
    });
}

export function registerQuote(program: Command): void {
  program
    .command("quote")
    .description("Quote a post")
    .argument("<uri>", "URI of the post to quote")
    .argument("<text...>", "Quote text")
    .option("--draft", "Save as draft instead of publishing")
    .action(async (uri: string, textParts: string[], opts: { draft?: boolean }) => {
      const text = textParts.join(" ");

      const draftData: Omit<Draft, "id" | "createdAt" | "reason"> = {
        type: "quote",
        text,
        quoteUri: uri,
      };

      if (opts.draft) {
        await executeOrDraft(program, draftData, opts, async () => ({ uri: "", cid: "" }));
        return;
      }

      const agent = await getClient(program);

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

      await executeOrDraft(program, draftData, opts, async () => {
        return createPost(agent, text, {
          quote: {
            uri: record.data.uri,
            cid: record.data.cid!,
          },
        });
      });
    });
}
