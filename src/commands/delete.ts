import type { Command } from "commander";
import { getClient } from "@/index";

type Client = Awaited<ReturnType<typeof getClient>>;

/**
 * Deletes each record from your own repo and prints its URI. A URI from another
 * collection is refused, so `unlike <post>` can't delete the post. Exits 1 if any was refused.
 */
export async function deleteRecords(
  agent: Client,
  uris: string[],
  command: string,
  collection: string,
  what: string,
): Promise<void> {
  for (const uri of uris) {
    const atUri = uri.startsWith("at://") ? uri : `at://did:plc:${uri}`;
    const parts = atUri.split("/");
    if (parts.length !== 5) {
      console.error(`Invalid ${what} URI: ${uri}`);
      process.exitCode = 1;
      continue;
    }
    const [, , , kind, rkey] = parts;
    if (kind !== collection) {
      console.error(`${command} takes a ${what}'s URI, not ${kind}: ${uri}`);
      process.exitCode = 1;
      continue;
    }

    await agent.com.atproto.repo.deleteRecord({ repo: agent.session!.did, collection, rkey });
    console.log(`at://${agent.session!.did}/${collection}/${rkey}`);
  }
}

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
        // Not the URI as given: only your own repo's record is deleted, whatever DID it names.
        console.log(`at://${agent.session!.did}/${collection}/${rkey}`);
      }
    });
}
