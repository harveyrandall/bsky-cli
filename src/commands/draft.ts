import chalk from "chalk";
import { stdin, stderr } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import type {
  AppBskyFeedPost,
  ComAtprotoRepoStrongRef,
} from "@atproto/api";
import { getClient, isJson } from "@/index";
import {
  listDrafts,
  loadDraft,
  deleteDraft,
  resolveDraftId,
} from "@/drafts";
import { createPost } from "@/commands/post";
import { outputJson } from "@/lib/format";

function reasonTag(reason: string): string {
  if (reason === "network") return ` ${chalk.yellow("[offline]")}`;
  if (reason === "length") return ` ${chalk.red("[too long]")}`;
  return "";
}

export async function syncNetworkDrafts(
  agent: Awaited<ReturnType<typeof getClient>>,
  profile?: string,
): Promise<void> {
  const all = await listDrafts(profile);
  const pending = all.filter((d) => d.reason === "network");
  if (pending.length === 0) return;

  if (!stdin.isTTY) {
    console.error(
      `${pending.length} draft(s) saved while offline. Run 'bsky drafts list' to review.`,
    );
    return;
  }

  console.error(`\n${pending.length} draft(s) saved while offline.`);
  const rl = createInterface({ input: stdin, output: stderr });
  const answer = await rl.question("Send them now? [Y/n] ");
  rl.close();
  if (answer.trim().toLowerCase() === "n") return;

  for (const draft of pending) {
    try {
      const opts: Parameters<typeof createPost>[2] = {
        images: draft.images,
        imageAlts: draft.imageAlts,
        video: draft.video,
        videoAlt: draft.videoAlt,
      };

      // Reconstruct reply refs
      if (draft.type === "reply" && draft.replyUri) {
        const atUri = draft.replyUri;
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
        const parentPost = record.data.value as AppBskyFeedPost.Record;
        opts.reply = parent;
        opts.replyRoot = (parentPost.reply?.root ??
          parent) as ComAtprotoRepoStrongRef.Main;
      }

      // Reconstruct quote ref
      if (draft.type === "quote" && draft.quoteUri) {
        const atUri = draft.quoteUri;
        const parts = atUri.split("/");
        const rkey = parts[parts.length - 1];
        const collection = parts[parts.length - 2];
        const did = parts[2];

        const record = await agent.com.atproto.repo.getRecord({
          repo: did,
          collection,
          rkey,
        });

        opts.quote = {
          uri: record.data.uri,
          cid: record.data.cid!,
        };
      }

      const result = await createPost(agent, draft.text, opts);
      await deleteDraft(draft.id, profile);
      console.error(`  Sent: ${result.uri}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Failed (${draft.id}): ${msg}`);
    }
  }
}

export function registerDrafts(program: Command): void {
  const drafts = program
    .command("drafts")
    .description("Manage saved drafts");

  drafts
    .command("list")
    .alias("ls")
    .description("List all saved drafts")
    .action(async () => {
      const profile = program.opts().profile;
      const json = isJson(program);
      const allDrafts = await listDrafts(profile);

      if (allDrafts.length === 0) {
        console.error("No drafts found.");
        return;
      }

      for (const draft of allDrafts) {
        if (json) {
          outputJson(draft);
        } else {
          const typeLabel = draft.type !== "post" ? ` [${draft.type}]` : "";
          const preview =
            draft.text.length > 80
              ? draft.text.slice(0, 77) + "..."
              : draft.text;
          console.log(
            `${chalk.blue(draft.id)}${typeLabel}${reasonTag(draft.reason)} (${draft.createdAt})`,
          );
          console.log(`  ${preview}`);
          if (draft.images?.length) {
            console.log(`  ${chalk.dim(`${draft.images.length} image(s)`)}`);
          }
          if (draft.video) {
            console.log(`  ${chalk.dim("1 video")}`);
          }
          console.log();
        }
      }
    });

  drafts
    .command("show")
    .description("Show full contents of a draft")
    .argument("<id>", "Draft ID (or unique prefix)")
    .action(async (partialId: string) => {
      const profile = program.opts().profile;
      const id = await resolveDraftId(partialId, profile);
      const draft = await loadDraft(id, profile);

      if (isJson(program)) {
        outputJson(draft);
      } else {
        console.log(`${chalk.blue("ID:")} ${draft.id}`);
        console.log(`${chalk.blue("Type:")} ${draft.type}`);
        console.log(`${chalk.blue("Reason:")} ${draft.reason}`);
        console.log(`${chalk.blue("Created:")} ${draft.createdAt}`);
        if (draft.replyUri)
          console.log(`${chalk.blue("Reply to:")} ${draft.replyUri}`);
        if (draft.quoteUri)
          console.log(`${chalk.blue("Quote of:")} ${draft.quoteUri}`);
        console.log(`${chalk.blue("Text:")}`);
        console.log(draft.text);
        if (draft.images?.length) {
          console.log(`${chalk.blue("Images:")}`);
          for (let i = 0; i < draft.images.length; i++) {
            const alt = draft.imageAlts?.[i] ?? "(no alt)";
            console.log(`  ${draft.images[i]} — ${alt}`);
          }
        }
        if (draft.video) {
          console.log(
            `${chalk.blue("Video:")} ${draft.video} — ${draft.videoAlt ?? "(no alt)"}`,
          );
        }
      }
    });

  drafts
    .command("send")
    .description("Publish a saved draft")
    .argument("<id>", "Draft ID (or unique prefix)")
    .action(async (partialId: string) => {
      const profile = program.opts().profile;
      const id = await resolveDraftId(partialId, profile);
      const draft = await loadDraft(id, profile);
      const agent = await getClient(program);

      const opts: Parameters<typeof createPost>[2] = {
        images: draft.images,
        imageAlts: draft.imageAlts,
        video: draft.video,
        videoAlt: draft.videoAlt,
      };

      // Reconstruct reply refs
      if (draft.type === "reply" && draft.replyUri) {
        const atUri = draft.replyUri;
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
        const parentPost = record.data.value as AppBskyFeedPost.Record;
        opts.reply = parent;
        opts.replyRoot = (parentPost.reply?.root ??
          parent) as ComAtprotoRepoStrongRef.Main;
      }

      // Reconstruct quote ref
      if (draft.type === "quote" && draft.quoteUri) {
        const atUri = draft.quoteUri;
        const parts = atUri.split("/");
        const rkey = parts[parts.length - 1];
        const collection = parts[parts.length - 2];
        const did = parts[2];

        const record = await agent.com.atproto.repo.getRecord({
          repo: did,
          collection,
          rkey,
        });

        opts.quote = {
          uri: record.data.uri,
          cid: record.data.cid!,
        };
      }

      const result = await createPost(agent, draft.text, opts);
      console.log(result.uri);
      await deleteDraft(id, profile);
      console.error(`Draft ${id} published and removed.`);
    });

  drafts
    .command("delete")
    .alias("rm")
    .description("Delete a saved draft")
    .argument("<id>", "Draft ID (or unique prefix)")
    .action(async (partialId: string) => {
      const profile = program.opts().profile;
      const id = await resolveDraftId(partialId, profile);
      await deleteDraft(id, profile);
      console.error(`Draft ${id} deleted.`);
    });
}
