import type { Command } from "commander";
import { getClient } from "@/index";

type Client = Awaited<ReturnType<typeof getClient>>;

/**
 * Deletes each record from your own repo and prints its URI. A URI from another
 * collection or account is refused, so `unlike <post>` can't delete the post. Exits 1 if any was refused.
 */
export async function deleteRecords(
  agent: Client,
  uris: string[],
  command: string,
  collection: string,
  what: string,
): Promise<void> {
  const { did, handle } = agent.session!;
  for (const uri of uris) {
    const atUri = uri.startsWith("at://") ? uri : `at://did:plc:${uri}`;
    const parts = atUri.split("/");
    if (parts.length !== 5) {
      console.error(`Invalid ${what} URI: ${uri}`);
      process.exitCode = 1;
      continue;
    }
    const [, , owner, kind, rkey] = parts;
    if (kind !== collection) {
      console.error(`${command} takes a ${what}'s URI, not ${kind}: ${uri}`);
      process.exitCode = 1;
      continue;
    }
    if (owner !== did && owner !== handle) {
      console.error(`That isn't yours: ${uri}`);
      process.exitCode = 1;
      continue;
    }

    const { data } = await agent.com.atproto.repo.deleteRecord({ repo: did, collection, rkey });
    // The PDS sends a commit only when it deleted something. One that never sends it would always say nothing was deleted.
    if (data.commit) console.log(`at://${did}/${collection}/${rkey}`);
    else console.error(`Nothing to delete: at://${did}/${collection}/${rkey}`);
  }
}

export function registerDelete(program: Command): void {
  program
    .command("delete")
    .description("Delete a post")
    .argument("<uri...>", "Post URI(s) to delete")
    .action(async (uris: string[]) => {
      const agent = await getClient(program);
      await deleteRecords(agent, uris, "delete", "app.bsky.feed.post", "post");
    });
}
