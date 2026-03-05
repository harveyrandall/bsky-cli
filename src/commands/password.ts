import type { Command } from "commander";
import { getClient, isJson } from "@/index";
import { outputJson } from "@/lib/format";

export function registerAppPassword(program: Command): void {
  const appPw = program
    .command("app-password")
    .description("Manage app passwords");

  appPw
    .command("list")
    .description("List app passwords")
    .action(async () => {
      const agent = await getClient(program);
      const json = isJson(program);

      const resp = await agent.com.atproto.server.listAppPasswords();
      const passwords = resp.data.passwords;

      if (json) {
        for (const pw of passwords) outputJson(pw);
        return;
      }

      for (const pw of passwords) {
        console.log(`${pw.name} (${pw.createdAt})`);
      }
    });

  appPw
    .command("add")
    .description("Create an app password")
    .argument("<name>", "Password name")
    .action(async (name: string) => {
      const agent = await getClient(program);
      const json = isJson(program);

      const resp = await agent.com.atproto.server.createAppPassword({
        name,
      });

      if (json) {
        outputJson(resp.data);
      } else {
        console.log(`${resp.data.name}: ${resp.data.password}`);
      }
    });

  appPw
    .command("revoke")
    .description("Revoke an app password")
    .argument("<name>", "Password name")
    .action(async (name: string) => {
      const agent = await getClient(program);
      await agent.com.atproto.server.revokeAppPassword({ name });
    });
}
