import { Command } from "commander";
import chalk from "chalk";
import { getClient, isJson } from "@/index";
import { formatTime, outputJson } from "@/lib/format";
import type { AtpAgent } from "@atproto/api";

const CHAT_PROXY =
  "did:web:api.bsky.chat#bsky_chat" as `did:${string}:${string}#${string}`;

async function getChatClient(program: Command): Promise<AtpAgent> {
  const agent = await getClient(program);
  agent.configureProxy(CHAT_PROXY);
  return agent;
}

async function resolveDid(
  agent: AtpAgent,
  handleOrDid: string,
): Promise<string> {
  if (handleOrDid.startsWith("did:")) return handleOrDid;
  const resp = await agent.getProfile({ actor: handleOrDid });
  return resp.data.did;
}

function isHandle(input: string): boolean {
  return input.includes(".");
}

interface ConvoMember {
  did: string;
  handle: string;
  displayName?: string;
}

interface ConvoView {
  id: string;
  members: ConvoMember[];
  muted: boolean;
  status?: string;
  unreadCount: number;
  lastMessage?: { $type?: string; text?: string; sentAt?: string };
}

interface MessageView {
  id: string;
  text?: string;
  sender: { did: string };
  sentAt: string;
  $type?: string;
}

function printConvo(convo: ConvoView, myDid: string): void {
  const others = convo.members.filter((m) => m.did !== myDid);
  const names = others.map((m) => {
    let label = chalk.redBright(`@${m.handle}`);
    if (m.displayName) label += ` [${m.displayName}]`;
    return label;
  });

  let line = names.join(", ");
  if (convo.unreadCount > 0) line += ` (${convo.unreadCount} unread)`;
  if (convo.muted) line += " [muted]";
  if (convo.status === "request") line += " [request]";
  console.log(line);

  if (convo.lastMessage?.text) {
    const preview =
      convo.lastMessage.text.length > 60
        ? convo.lastMessage.text.slice(0, 60) + "..."
        : convo.lastMessage.text;
    const time = convo.lastMessage.sentAt
      ? formatTime(convo.lastMessage.sentAt)
      : "";
    console.log(`  "${preview}"  ${time}`);
  }

  console.log(`  convo: ${convo.id}`);
  console.log();
}

function printMessage(message: MessageView, members: ConvoMember[]): void {
  if (message.$type === "chat.bsky.convo.defs#deletedMessageView") {
    console.log(chalk.dim("[deleted]"));
    console.log();
    return;
  }

  const sender = members.find((m) => m.did === message.sender.did);
  const handle = sender?.handle ?? message.sender.did;
  process.stdout.write(chalk.redBright(`@${handle}`));
  console.log(`  ${formatTime(message.sentAt)}`);
  console.log(`  ${message.text ?? ""}`);
  console.log();
}

export function registerDm(program: Command): void {
  const dm = new Command("dm").description("Direct messages");

  // dm list
  dm.command("list")
    .description("List conversations")
    .option("-n, --count <number>", "Number of conversations", "50")
    .option("--unread", "Only show unread conversations")
    .option("--requests", "Show conversation requests")
    .action(async (opts: { count: string; unread?: boolean; requests?: boolean }) => {
      const agent = await getChatClient(program);
      const json = isJson(program);
      const limit = parseInt(opts.count, 10);

      const params: Record<string, unknown> = {
        limit: Math.min(limit, 100),
      };
      if (opts.unread) params.readState = "unread";
      if (opts.requests) params.status = "request";

      let cursor: string | undefined;
      let remaining = limit;

      do {
        const resp = await agent.chat.bsky.convo.listConvos({
          ...params,
          cursor,
        } as Parameters<typeof agent.chat.bsky.convo.listConvos>[0]);

        for (const convo of resp.data.convos) {
          if (json) {
            outputJson(convo);
          } else {
            printConvo(convo as unknown as ConvoView, agent.session!.did);
          }
        }

        remaining -= resp.data.convos.length;
        cursor = resp.data.cursor;
      } while (cursor && remaining > 0);
    });

  // dm read
  dm.command("read")
    .description("Read messages in a conversation")
    .argument("<handle-or-convo-id>", "Handle or conversation ID")
    .option("-n, --count <number>", "Number of messages", "30")
    .action(async (target: string, opts: { count: string }) => {
      const agent = await getChatClient(program);
      const json = isJson(program);
      const limit = parseInt(opts.count, 10);

      let convoId: string;
      let members: ConvoMember[] = [];

      if (isHandle(target)) {
        const did = await resolveDid(agent, target);
        const availability =
          await agent.chat.bsky.convo.getConvoAvailability({
            members: [agent.session!.did, did],
          });
        if (!availability.data.convo) {
          console.error(`No conversation found with ${target}`);
          process.exitCode = 1;
          return;
        }
        convoId = availability.data.convo.id;
        members = availability.data.convo.members as ConvoMember[];
      } else {
        convoId = target;
        const convoResp = await agent.chat.bsky.convo.getConvo({
          convoId,
        });
        members = convoResp.data.convo.members as ConvoMember[];
      }

      const resp = await agent.chat.bsky.convo.getMessages({
        convoId,
        limit: Math.min(limit, 100),
      });

      const messages = [...resp.data.messages].reverse();

      for (const msg of messages) {
        if (json) {
          outputJson(msg);
        } else {
          printMessage(msg as unknown as MessageView, members);
        }
      }
    });

  // dm send
  dm.command("send")
    .description("Send a direct message")
    .argument("<handle>", "Handle or DID of the recipient")
    .argument("[text...]", "Message text")
    .option("--stdin", "Read message text from stdin")
    .action(
      async (
        handle: string,
        textParts: string[],
        opts: { stdin?: boolean },
      ) => {
        const agent = await getChatClient(program);
        const json = isJson(program);

        let text: string;
        if (opts.stdin) {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) {
            chunks.push(chunk as Buffer);
          }
          text = Buffer.concat(chunks).toString("utf-8").trimEnd();
        } else {
          text = textParts.join(" ");
        }

        if (!text) {
          console.error("No message text provided");
          process.exitCode = 1;
          return;
        }

        const did = await resolveDid(agent, handle);
        const convoResp = await agent.chat.bsky.convo.getConvoForMembers({
          members: [agent.session!.did, did],
        });

        const resp = await agent.chat.bsky.convo.sendMessage({
          convoId: convoResp.data.convo.id,
          message: { text },
        });

        if (json) {
          outputJson(resp.data);
        } else {
          console.log(resp.data.id);
        }
      },
    );

  // dm delete
  dm.command("delete")
    .description("Delete a message (for yourself)")
    .argument("<convo-id>", "Conversation ID")
    .argument("<message-id>", "Message ID")
    .action(async (convoId: string, messageId: string) => {
      const agent = await getChatClient(program);
      await agent.chat.bsky.convo.deleteMessageForSelf({
        convoId,
        messageId,
      });
      console.log("Deleted");
    });

  // dm mute
  dm.command("mute")
    .description("Mute a conversation")
    .argument("<convo-id>", "Conversation ID")
    .action(async (convoId: string) => {
      const agent = await getChatClient(program);
      await agent.chat.bsky.convo.muteConvo({ convoId });
      console.log("Muted");
    });

  // dm unmute
  dm.command("unmute")
    .description("Unmute a conversation")
    .argument("<convo-id>", "Conversation ID")
    .action(async (convoId: string) => {
      const agent = await getChatClient(program);
      await agent.chat.bsky.convo.unmuteConvo({ convoId });
      console.log("Unmuted");
    });

  // dm accept
  dm.command("accept")
    .description("Accept a conversation request")
    .argument("<convo-id>", "Conversation ID")
    .action(async (convoId: string) => {
      const agent = await getChatClient(program);
      await agent.chat.bsky.convo.acceptConvo({ convoId });
      console.log("Accepted");
    });

  // dm mark-read
  dm.command("mark-read")
    .description("Mark conversation(s) as read")
    .argument("[convo-id]", "Conversation ID (omit with --all)")
    .option("--all", "Mark all conversations as read")
    .action(async (convoId: string | undefined, opts: { all?: boolean }) => {
      const agent = await getChatClient(program);

      if (opts.all) {
        await agent.chat.bsky.convo.updateAllRead({});
        console.log("All conversations marked as read");
      } else if (convoId) {
        await agent.chat.bsky.convo.updateRead({ convoId });
        console.log("Marked as read");
      } else {
        console.error(
          "Provide a conversation ID or use --all",
        );
        process.exitCode = 1;
      }
    });

  program.addCommand(dm);
}
