import type { Command } from "commander";
import { getClient } from "@/index";

async function resolveDid(
  agent: Awaited<ReturnType<typeof getClient>>,
  handleOrDid: string,
): Promise<string> {
  if (handleOrDid.startsWith("did:")) return handleOrDid;
  const profile = await agent.getProfile({ actor: handleOrDid });
  return profile.data.did;
}

export function registerReport(program: Command): void {
  program
    .command("report")
    .description("Report a user")
    .argument("<handle>", "Handle or DID to report")
    .option("--comment <text>", "Report comment")
    .action(async (handle: string, opts: { comment?: string }) => {
      const agent = await getClient(program);
      const did = await resolveDid(agent, handle);

      const resp = await agent.com.atproto.moderation.createReport({
        reasonType: "com.atproto.moderation.defs#reasonSpam",
        subject: {
          $type: "com.atproto.admin.defs#repoRef",
          did,
        },
        reason: opts.comment,
      });

      console.log("Report created successfully:", JSON.stringify(resp.data));
    });
}

export function registerModList(program: Command): void {
  program
    .command("mod-list")
    .description("Create a moderation list with user(s)")
    .argument("<handles...>", "Handle(s) or DID(s) to add")
    .option("--name <name>", "List name", "NewList")
    .option("--desc <description>", "List description", "")
    .action(
      async (
        handles: string[],
        opts: { name: string; desc: string },
      ) => {
        const agent = await getClient(program);

        // Create the list
        const listResp = await agent.com.atproto.repo.createRecord({
          repo: agent.session!.did,
          collection: "app.bsky.graph.list",
          record: {
            $type: "app.bsky.graph.list",
            name: opts.name,
            purpose: "app.bsky.graph.defs#modlist",
            description: opts.desc,
            createdAt: new Date().toISOString(),
          },
        });

        console.log("List created successfully. URI:", listResp.data.uri);

        // Add users to the list
        for (const handle of handles) {
          const did = await resolveDid(agent, handle);

          await agent.com.atproto.repo.createRecord({
            repo: agent.session!.did,
            collection: "app.bsky.graph.listitem",
            record: {
              $type: "app.bsky.graph.listitem",
              subject: did,
              list: listResp.data.uri,
              createdAt: new Date().toISOString(),
            },
          });

          console.log("User added to moderation list successfully.");
        }
      },
    );
}
