import { AtpAgent } from "@atproto/api";
import { readAuth, writeAuth, prompt2FA } from "@/auth";
import type { Config } from "@/lib/types";

export async function createClient(
  config: Config,
  prefix: string = "",
): Promise<AtpAgent> {
  const agent = new AtpAgent({ service: config.host });

  // Try refreshing existing session first
  const auth = await readAuth(config.handle, prefix);
  if (auth) {
    try {
      // Resume session using saved auth, then refresh
      await agent.resumeSession({
        did: auth.did,
        handle: auth.handle,
        accessJwt: auth.refreshJwt,
        refreshJwt: auth.refreshJwt,
        active: true,
      });

      const refreshed = await agent.com.atproto.server.refreshSession(
        undefined,
        {
          headers: {
            authorization: `Bearer ${auth.refreshJwt}`,
          },
        },
      );

      // Resume with refreshed tokens
      await agent.resumeSession({
        did: refreshed.data.did,
        handle: refreshed.data.handle,
        accessJwt: refreshed.data.accessJwt,
        refreshJwt: refreshed.data.refreshJwt,
        active: true,
      });

      await writeAuth(
        {
          did: refreshed.data.did,
          handle: refreshed.data.handle,
          accessJwt: refreshed.data.accessJwt,
          refreshJwt: refreshed.data.refreshJwt,
        },
        config.handle,
        prefix,
      );

      return agent;
    } catch {
      // Refresh failed, fall through to full login
    }
  }

  // Full login with credentials
  try {
    const loginResponse = await agent.login({
      identifier: config.handle,
      password: config.password,
    });

    await writeAuth(
      {
        did: loginResponse.data.did,
        handle: loginResponse.data.handle,
        accessJwt: loginResponse.data.accessJwt,
        refreshJwt: loginResponse.data.refreshJwt,
      },
      config.handle,
      prefix,
    );

    return agent;
  } catch (err: unknown) {
    // Handle 2FA
    if (
      err instanceof Error &&
      err.message.includes("AuthFactorTokenRequired")
    ) {
      const token = await prompt2FA();
      const loginResponse = await agent.login({
        identifier: config.handle,
        password: config.password,
        authFactorToken: token,
      });

      await writeAuth(
        {
          did: loginResponse.data.did,
          handle: loginResponse.data.handle,
          accessJwt: loginResponse.data.accessJwt,
          refreshJwt: loginResponse.data.refreshJwt,
        },
        config.handle,
        prefix,
      );

      return agent;
    }

    throw new Error(`Cannot create session: ${err}`);
  }
}
