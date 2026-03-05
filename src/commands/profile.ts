import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { getClient, isJson } from "@/index";
import { outputJson } from "@/lib/format";

function detectMimeType(data: Uint8Array): string {
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
  return "application/octet-stream";
}

export function registerProfile(program: Command): void {
  program
    .command("profile")
    .description("Show profile")
    .option("-H, --handle <handle>", "User handle")
    .action(async (opts: { handle?: string }) => {
      const agent = await getClient(program);
      const json = isJson(program);
      const handle = opts.handle ?? agent.session!.handle;

      const resp = await agent.getProfile({ actor: handle });
      const profile = resp.data;

      if (json) {
        outputJson(profile);
        return;
      }

      console.log(`Did: ${profile.did}`);
      console.log(`Handle: ${profile.handle}`);
      console.log(`DisplayName: ${profile.displayName ?? ""}`);
      console.log(`Description: ${profile.description ?? ""}`);
      console.log(`Follows: ${profile.followsCount ?? 0}`);
      console.log(`Followers: ${profile.followersCount ?? 0}`);
      console.log(`Avatar: ${profile.avatar ?? ""}`);
      console.log(`Banner: ${profile.banner ?? ""}`);
    });
}

export function registerProfileUpdate(program: Command): void {
  program
    .command("profile-update")
    .description("Update profile")
    .argument("[displayname]", "Display name")
    .argument("[description]", "Description")
    .option("--avatar <file>", "Avatar image file")
    .option("--banner <file>", "Banner image file")
    .action(
      async (
        displayName: string | undefined,
        description: string | undefined,
        opts: { avatar?: string; banner?: string },
      ) => {
        if (!displayName && !description && !opts.avatar && !opts.banner) {
          console.error("Error: provide at least one field to update");
          process.exit(1);
        }

        const agent = await getClient(program);

        // Get current profile
        const current = await agent.getProfile({
          actor: agent.session!.handle,
        });

        const name = displayName ?? current.data.displayName;
        const desc = description ?? current.data.description;

        let avatar: unknown = undefined;
        if (opts.avatar) {
          const data = await readFile(opts.avatar);
          const uploadResp = await agent.uploadBlob(data, {
            encoding: detectMimeType(data),
          });
          avatar = uploadResp.data.blob;
        }

        let banner: unknown = undefined;
        if (opts.banner) {
          const data = await readFile(opts.banner);
          const uploadResp = await agent.uploadBlob(data, {
            encoding: detectMimeType(data),
          });
          banner = uploadResp.data.blob;
        }

        // Get current record for swap
        const currentRecord = await agent.com.atproto.repo.getRecord({
          repo: agent.session!.did,
          collection: "app.bsky.actor.profile",
          rkey: "self",
        });

        await agent.com.atproto.repo.putRecord({
          repo: agent.session!.did,
          collection: "app.bsky.actor.profile",
          rkey: "self",
          record: {
            $type: "app.bsky.actor.profile",
            displayName: name,
            description: desc,
            ...(avatar ? { avatar } : {}),
            ...(banner ? { banner } : {}),
          },
          swapRecord: currentRecord.data.cid,
        });
      },
    );
}

export function registerSession(program: Command): void {
  program
    .command("session")
    .description("Show session info")
    .action(async () => {
      const agent = await getClient(program);
      const json = isJson(program);

      const resp = await agent.com.atproto.server.getSession();
      const session = resp.data;

      if (json) {
        outputJson(session);
        return;
      }

      console.log(`Did: ${session.did}`);
      console.log(`Email: ${session.email ?? ""}`);
      console.log(`Handle: ${session.handle}`);
    });
}
