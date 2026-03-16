import type { Command } from "commander";
import { AtpAgent } from "@atproto/api";
import chalk from "chalk";
import { saveSessionConfig } from "@/config";
import { promptPassword, prompt2FA } from "@/auth";
import { keychainStore, sessionKey } from "@/lib/credential-store";
import type { SessionConfig } from "@/lib/types";

export function registerLogin(program: Command): void {
  program
    .command("login")
    .description("Login to Bluesky")
    .argument("<handle>", "Your Bluesky handle")
    .argument("[password]", "Your app password (prompts if omitted)")
    .option("--host <url>", "PDS host URL", "https://bsky.social")
    .option("--bgs <url>", "BGS host URL", "https://bsky.network")
    .action(
      async (
        handle: string,
        password: string | undefined,
        opts: { host: string; bgs: string },
      ) => {
        // Password resolution: CLI arg → env var → secure prompt
        // Password is NEVER saved to disk — only used for this login call
        const resolvedPassword =
          password ?? process.env.BSKY_PASSWORD ?? (await promptPassword());
        const profile = program.opts().profile;

        // Authenticate immediately
        const agent = new AtpAgent({ service: opts.host });
        let loginResponse;

        try {
          loginResponse = await agent.login({
            identifier: handle,
            password: resolvedPassword,
          });
        } catch (err: unknown) {
          // Handle 2FA
          if (
            err instanceof Error &&
            err.message.includes("AuthFactorTokenRequired")
          ) {
            const token = await prompt2FA();
            loginResponse = await agent.login({
              identifier: handle,
              password: resolvedPassword,
              authFactorToken: token,
            });
          } else {
            throw new Error(
              `Login failed: ${err instanceof Error ? err.message : err}`,
            );
          }
        }

        // Save session (NO password — only JWT tokens)
        const session: SessionConfig = {
          host: opts.host,
          bgs: opts.bgs,
          handle: loginResponse.data.handle,
          did: loginResponse.data.did,
          accessJwt: loginResponse.data.accessJwt,
          refreshJwt: loginResponse.data.refreshJwt,
        };

        await saveSessionConfig(session, profile);

        // Try storing in OS keychain as well (best-effort)
        const key = sessionKey(loginResponse.data.handle, profile);
        await keychainStore(key, JSON.stringify(session));

        console.error(
          chalk.green(
            `Logged in as ${loginResponse.data.handle} (${loginResponse.data.did})`,
          ),
        );
      },
    );
}
