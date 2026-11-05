import type { Command } from "commander";
import chalk from "chalk";
import { getClient, isJson } from "@/index";
import { outputJson } from "@/lib/format";

type Client = Awaited<ReturnType<typeof getClient>>;

export async function repostPost(agent: Client, post: { uri: string; cid: string }): Promise<string> {
  const { uri } = await agent.repost(post.uri, post.cid);
  return uri;
}

/** Removes your repost of a post, which the post itself knows. False if there wasn't one. */
export async function unrepostPost(agent: Client, postUri: string): Promise<boolean> {
  const { data } = await agent.getPosts({ uris: [postUri] });
  const repost = data.posts[0]?.viewer?.repost;
  if (repost) await agent.deleteRepost(repost);
  return repost !== undefined;
}

export function registerRepost(program: Command): void {
  program
    .command("repost")
    .description("Repost a post")
    .argument("<uri...>", "Post URI(s) to repost")
    .action(async (uris: string[]) => {
      const agent = await getClient(program);

      for (const uri of uris) {
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

        console.log(await repostPost(agent, { uri: record.data.uri, cid: record.data.cid! }));
      }
    });
}

export function registerRemoveRepost(program: Command): void {
  program
    .command("remove-repost")
    .alias("unrepost")
    .description("Remove a repost")
    .argument("<uri...>", "Repost URI(s) to remove")
    .action(async (uris: string[]) => {
      const agent = await getClient(program);

      for (const uri of uris) {
        const atUri = uri.startsWith("at://") ? uri : `at://did:plc:${uri}`;
        const parts = atUri.split("/");
        if (parts.length < 3) {
          console.error(`Invalid URI: ${uri}`);
          continue;
        }
        const rkey = parts[parts.length - 1];
        const collection = parts[parts.length - 2];

        await agent.com.atproto.repo.deleteRecord({
          repo: agent.session!.did,
          collection,
          rkey,
        });
      }
    });
}

export function registerReposts(program: Command): void {
  program
    .command("reposts")
    .description("Show reposts of a post")
    .argument("<uri>", "Post URI")
    .action(async (uri: string) => {
      const agent = await getClient(program);
      const json = isJson(program);

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

      const resp = await agent.getRepostedBy({
        uri: record.data.uri,
        cid: record.data.cid,
        limit: 50,
      });

      if (json) {
        for (const r of resp.data.repostedBy) outputJson(r);
        return;
      }

      for (const r of resp.data.repostedBy) {
        process.stdout.write("⚡ ");
        process.stdout.write(chalk.redBright(r.handle));
        console.log(` [${r.displayName ?? ""}]`);
      }
    });
}
