import type { Command } from "commander";
import { getClient } from "../index.js";

export function registerDelete(program: Command): void {
  program
    .command("delete")
    .description("Delete a post")
    .argument("<uri...>", "Post URI(s) to delete")
    .action(async (uris: string[]) => {
      const agent = await getClient(program);

      for (const uri of uris) {
        const atUri = uri.startsWith("at://") ? uri : `at://did:plc:${uri}`;
        const parts = atUri.split("/");
        if (parts.length < 3) {
          console.error(`Invalid post URI: ${uri}`);
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
