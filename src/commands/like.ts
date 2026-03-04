import type { Command } from "commander";
import chalk from "chalk";
import { getClient, isJson } from "../index.js";
import { outputJson } from "../lib/format.js";

export function registerLike(program: Command): void {
  program
    .command("like")
    .description("Like a post")
    .argument("<uri...>", "Post URI(s) to like")
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

        const resp = await agent.like(record.data.uri, record.data.cid!);
        console.log(resp.uri);
      }
    });
}

export function registerLikes(program: Command): void {
  program
    .command("likes")
    .description("Show likes on a post")
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

      const resp = await agent.getLikes({
        uri: record.data.uri,
        cid: record.data.cid,
        limit: 50,
      });

      if (json) {
        for (const v of resp.data.likes) outputJson(v);
        return;
      }

      for (const v of resp.data.likes) {
        process.stdout.write("👍 ");
        process.stdout.write(chalk.redBright(v.actor.handle));
        process.stdout.write(` [${v.actor.displayName ?? ""}]`);
        console.log(` (${v.createdAt})`);
      }
    });
}
