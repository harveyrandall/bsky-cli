import type { Command } from "commander";
import chalk from "chalk";
import { getClient, isJson } from "../index.js";
import { outputJson } from "../lib/format.js";

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

        const resp = await agent.repost(record.data.uri, record.data.cid!);
        console.log(resp.uri);
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
