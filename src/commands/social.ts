import type { Command } from "commander";
import { getClient, isJson } from "../index.js";
import { printActor, outputJson } from "../lib/format.js";

async function resolveDid(
  agent: Awaited<ReturnType<typeof getClient>>,
  handleOrDid: string,
): Promise<string> {
  if (handleOrDid.startsWith("did:")) return handleOrDid;
  const profile = await agent.getProfile({ actor: handleOrDid });
  return profile.data.did;
}

export function registerFollow(program: Command): void {
  program
    .command("follow")
    .description("Follow user(s)")
    .argument("<handles...>", "Handle(s) to follow")
    .action(async (handles: string[]) => {
      const agent = await getClient(program);

      for (const handle of handles) {
        const profile = await agent.getProfile({ actor: handle });
        const resp = await agent.follow(profile.data.did);
        console.log(resp.uri);
      }
    });
}

export function registerUnfollow(program: Command): void {
  program
    .command("unfollow")
    .description("Unfollow user(s)")
    .argument("<handles...>", "Handle(s) to unfollow")
    .action(async (handles: string[]) => {
      const agent = await getClient(program);

      for (const handle of handles) {
        const profile = await agent.getProfile({ actor: handle });
        const followUri = profile.data.viewer?.following;
        if (!followUri) continue;

        const parts = followUri.split("/");
        const rkey = parts[parts.length - 1];
        const collection = parts[parts.length - 2];

        console.log(followUri);
        await agent.com.atproto.repo.deleteRecord({
          repo: agent.session!.did,
          collection,
          rkey,
        });
      }
    });
}

export function registerFollows(program: Command): void {
  program
    .command("follows")
    .description("Show follows")
    .option("-H, --handle <handle>", "User handle")
    .action(async (opts: { handle?: string }) => {
      const agent = await getClient(program);
      const json = isJson(program);
      const handle = opts.handle ?? agent.session!.handle;

      let cursor: string | undefined;
      while (true) {
        const resp = await agent.getFollows({
          actor: handle,
          cursor,
          limit: 100,
        });

        if (json) {
          for (const f of resp.data.follows) outputJson(f);
        } else {
          for (const f of resp.data.follows) printActor(f);
        }

        cursor = resp.data.cursor;
        if (!cursor) break;
      }
    });
}

export function registerFollowers(program: Command): void {
  program
    .command("followers")
    .description("Show followers")
    .option("-H, --handle <handle>", "User handle")
    .action(async (opts: { handle?: string }) => {
      const agent = await getClient(program);
      const json = isJson(program);
      const handle = opts.handle ?? agent.session!.handle;

      let cursor: string | undefined;
      while (true) {
        const resp = await agent.getFollowers({
          actor: handle,
          cursor,
          limit: 100,
        });

        if (json) {
          for (const f of resp.data.followers) outputJson(f);
        } else {
          for (const f of resp.data.followers) printActor(f);
        }

        cursor = resp.data.cursor;
        if (!cursor) break;
      }
    });
}

export function registerBlock(program: Command): void {
  program
    .command("block")
    .description("Block user(s)")
    .argument("<handles...>", "Handle(s) or DID(s) to block")
    .action(async (handles: string[]) => {
      const agent = await getClient(program);

      for (const handle of handles) {
        const did = await resolveDid(agent, handle);

        const resp = await agent.com.atproto.repo.createRecord({
          repo: agent.session!.did,
          collection: "app.bsky.graph.block",
          record: {
            $type: "app.bsky.graph.block",
            createdAt: new Date().toISOString(),
            subject: did,
          },
        });
        console.log(resp.data.uri);
      }
    });
}

export function registerUnblock(program: Command): void {
  program
    .command("unblock")
    .description("Unblock user(s)")
    .argument("<handles...>", "Handle(s) to unblock")
    .action(async (handles: string[]) => {
      const agent = await getClient(program);

      for (const handle of handles) {
        const profile = await agent.getProfile({ actor: handle });
        const blockUri = profile.data.viewer?.blocking;
        if (!blockUri) continue;

        const parts = blockUri.split("/");
        const rkey = parts[parts.length - 1];
        const collection = parts[parts.length - 2];

        console.log(blockUri);
        await agent.com.atproto.repo.deleteRecord({
          repo: agent.session!.did,
          collection,
          rkey,
        });
      }
    });
}

export function registerBlocks(program: Command): void {
  program
    .command("blocks")
    .description("Show blocked users")
    .option("-H, --handle <handle>", "User handle")
    .action(async () => {
      const agent = await getClient(program);
      const json = isJson(program);

      let cursor: string | undefined;
      while (true) {
        const resp = await agent.app.bsky.graph.getBlocks({
          cursor,
          limit: 100,
        });

        if (json) {
          for (const b of resp.data.blocks) outputJson(b);
        } else {
          for (const b of resp.data.blocks) printActor(b);
        }

        cursor = resp.data.cursor;
        if (!cursor) break;
      }
    });
}

export function registerMute(program: Command): void {
  program
    .command("mute")
    .description("Mute user(s)")
    .argument("<handles...>", "Handle(s) or DID(s) to mute")
    .action(async (handles: string[]) => {
      const agent = await getClient(program);

      for (const handle of handles) {
        const did = await resolveDid(agent, handle);
        await agent.mute(did);
      }
    });
}
