import type { Command } from "commander";
import { saveConfig } from "@/config";
import type { Config } from "@/lib/types";

export function registerLogin(program: Command): void {
  program
    .command("login")
    .description("Login to Bluesky")
    .argument("<handle>", "Your Bluesky handle")
    .argument("<password>", "Your app password")
    .option("--host <url>", "PDS host URL", "https://bsky.social")
    .option("--bgs <url>", "BGS host URL", "https://bsky.network")
    .action(
      async (
        handle: string,
        password: string,
        opts: { host: string; bgs: string },
      ) => {
        const profile = program.opts().profile;
        const config: Config = {
          host: opts.host,
          bgs: opts.bgs,
          handle,
          password,
        };
        await saveConfig(config, profile);
      },
    );
}
