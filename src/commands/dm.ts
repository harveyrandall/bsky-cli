import { Command } from "commander";
import { ChatBskyConvoDefs } from "@atproto/api";
import { getClient, isJson } from "@/index";
import { printConvo, printMessage, outputJson } from "@/lib/format";

async function resolveConvoId(
  agent: Awaited<ReturnType<typeof getClient>>,
  handle: string,
): Promise<string> {
  const did = handle.startsWith("did:")
    ? handle
    : (await agent.getProfile({ actor: handle })).data.did;
  const resp = await agent.chat.bsky.convo.getConvoForMembers({
    members: [agent.session!.did, did],
  });
  return resp.data.convo.id;
}

export function registerDm(program: Command): void {
  const dm = new Command("dm").description("Direct messages");

  dm.command("list")
    .description("List DM conversations")
    .option("--unread", "Show only unread conversations")
    .option("--requests", "Show conversation requests")
    .option("-n <count>", "Number of conversations", "50")
    .action(async (opts: { unread?: boolean; requests?: boolean; n: string }) => {
      const agent = await getClient(program);
      const json = isJson(program);
      const limit = parseInt(opts.n, 10);

      let cursor: string | undefined;
      let count = 0;
      while (true) {
        const resp = await agent.chat.bsky.convo.listConvos({
          cursor,
          limit: Math.min(limit - count, 100),
          readState: opts.unread ? "unread" : undefined,
          status: opts.requests ? "request" : undefined,
        });

        for (const convo of resp.data.convos) {
          if (json) {
            outputJson(convo);
          } else {
            printConvo(convo, agent.session!.did);
          }
          count++;
          if (count >= limit) break;
        }

        cursor = resp.data.cursor;
        if (!cursor || count >= limit) break;
      }
    });

  dm.command("read")
    .description("Read messages in a conversation")
    .argument("<handle>", "Handle or DID of the other user")
    .option("-n <count>", "Number of messages", "30")
    .action(async (handle: string, opts: { n: string }) => {
      const agent = await getClient(program);
      const json = isJson(program);
      const limit = parseInt(opts.n, 10);

      const convoId = await resolveConvoId(agent, handle);
      const convoResp = await agent.chat.bsky.convo.getConvo({ convoId });
      const members = convoResp.data.convo.members;

      const resp = await agent.chat.bsky.convo.getMessages({
        convoId,
        limit,
      });

      const messages = [...resp.data.messages].reverse();

      for (const msg of messages) {
        if (json) {
          outputJson(msg);
        } else if (
          ChatBskyConvoDefs.isMessageView(msg) ||
          ChatBskyConvoDefs.isDeletedMessageView(msg)
        ) {
          printMessage(msg, members);
        }
      }
    });

  dm.command("send")
    .description("Send a direct message")
    .argument("<handle>", "Handle or DID of the recipient")
    .argument("<text...>", "Message text")
    .action(async (handle: string, textParts: string[]) => {
      const text = textParts.join(" ");
      if (!text.trim()) {
        program.error("message text is required");
      }

      const agent = await getClient(program);
      const convoId = await resolveConvoId(agent, handle);

      const resp = await agent.chat.bsky.convo.sendMessage({
        convoId,
        message: { text },
      });
      console.log(resp.data.id);
    });

  dm.command("delete")
    .description("Delete a message for yourself")
    .argument("<handle>", "Handle or DID of the conversation partner")
    .argument("<messageId>", "Message ID to delete")
    .action(async (handle: string, messageId: string) => {
      const agent = await getClient(program);
      const convoId = await resolveConvoId(agent, handle);

      await agent.chat.bsky.convo.deleteMessageForSelf({
        convoId,
        messageId,
      });
    });

  dm.command("accept")
    .description("Accept a conversation request")
    .argument("<handle>", "Handle or DID of the requesting user")
    .action(async (handle: string) => {
      const agent = await getClient(program);
      const convoId = await resolveConvoId(agent, handle);

      await agent.chat.bsky.convo.acceptConvo({ convoId });
    });

  dm.command("mark-read")
    .description("Mark a conversation as read")
    .argument("<handle>", "Handle or DID of the conversation partner")
    .action(async (handle: string) => {
      const agent = await getClient(program);
      const convoId = await resolveConvoId(agent, handle);

      await agent.chat.bsky.convo.updateRead({ convoId });
    });

  dm.command("mute")
    .description("Mute a conversation")
    .argument("<handle>", "Handle or DID of the conversation partner")
    .action(async (handle: string) => {
      const agent = await getClient(program);
      const convoId = await resolveConvoId(agent, handle);

      await agent.chat.bsky.convo.muteConvo({ convoId });
    });

  dm.command("unmute")
    .description("Unmute a conversation")
    .argument("<handle>", "Handle or DID of the conversation partner")
    .action(async (handle: string) => {
      const agent = await getClient(program);
      const convoId = await resolveConvoId(agent, handle);

      await agent.chat.bsky.convo.unmuteConvo({ convoId });
    });

  program.addCommand(dm);
}
