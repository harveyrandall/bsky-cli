import type { Command } from "commander";
import chalk from "chalk";
import { getClient, isJson } from "@/index";
import { outputJson } from "@/lib/format";

export function registerInviteCodes(program: Command): void {
  program
    .command("invite-codes")
    .description("Show invite codes")
    .option("--used", "Show used codes too")
    .action(async (opts: { used?: boolean }) => {
      const agent = await getClient(program);
      const json = isJson(program);

      const resp = await agent.com.atproto.server.getAccountInviteCodes({
        includeUsed: opts.used ?? false,
      });

      const codes = resp.data.codes;

      if (json) {
        for (const c of codes) outputJson(c);
        return;
      }

      for (const c of codes) {
        if (c.uses.length >= c.available) {
          console.log(chalk.magentaBright(`${c.code} (used)`));
        } else {
          console.log(c.code);
        }
      }
    });
}
