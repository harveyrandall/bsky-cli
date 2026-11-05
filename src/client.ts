import { AtpAgent } from "@atproto/api";
import { saveSessionConfig } from "@/config";
import type { SessionConfig } from "@/lib/types";

const clients = new Map<string, AtpAgent>();

/**
 * One sign-in per profile, however often a process asks: the REPL runs CLI commands
 * all session, and each new sign-in would spend the refresh token its own agent holds.
 * Everyone gets a clone, which shares the session but can set its own proxy.
 */
export async function sharedClient(profile: string | undefined, signIn: () => Promise<AtpAgent>): Promise<AtpAgent> {
  const known = clients.get(profile ?? "");
  if (known?.hasSession) return known.clone();
  const agent = await signIn();
  clients.set(profile ?? "", agent);
  return agent.clone();
}

/**
 * Create an authenticated AT Protocol client from a saved session.
 *
 * This function does NOT take a password — authentication happens
 * during `bsky login`. Here we only resume and refresh the saved
 * JWT tokens. If the refresh token has expired, the user must
 * run `bsky login` again.
 */
export async function createClient(
  session: SessionConfig,
  profile?: string,
): Promise<AtpAgent> {
  const agent = new AtpAgent({ service: session.host });

  try {
    // Resume session using saved tokens
    await agent.resumeSession({
      did: session.did,
      handle: session.handle,
      accessJwt: session.refreshJwt,
      refreshJwt: session.refreshJwt,
      active: true,
    });

    // Refresh to get fresh access token
    const refreshed = await agent.com.atproto.server.refreshSession(
      undefined,
      {
        headers: {
          authorization: `Bearer ${session.refreshJwt}`,
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

    // Persist refreshed tokens
    const updated: SessionConfig = {
      ...session,
      did: refreshed.data.did,
      handle: refreshed.data.handle,
      accessJwt: refreshed.data.accessJwt,
      refreshJwt: refreshed.data.refreshJwt,
    };
    await saveSessionConfig(updated, profile);

    return agent;
  } catch {
    throw new Error(
      "Session expired. Run 'bsky login' to re-authenticate.",
    );
  }
}
