import { AtpAgent } from "@atproto/api";
import chalk from "chalk";
import { findProfile, saveSessionConfig, sessionDid } from "@/config";
import { isNetworkError } from "@/lib/errors";
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

/** A failure can't be thrown from here: the library would put the spent token back. */
function saveRefreshed(session: SessionConfig, profile?: string): void {
  // A session can outlive its place in the file: `bsky login` in another terminal, say.
  const owner = sessionDid(profile);
  if (owner && owner !== session.did) {
    console.error(chalk.yellow("Another account has logged in to this profile, so this session's tokens weren't saved"));
    return;
  }
  try {
    saveSessionConfig(session, profile);
  } catch (err) {
    console.error(chalk.yellow(`Couldn't save your session, so you may need to log in again: ${err instanceof Error ? err.message : String(err)}`));
  }
}

/**
 * Create an authenticated AT Protocol client from a saved session.
 *
 * This function does NOT take a password — authentication happens
 * during `bsky login`. Here we only resume the saved JWT tokens, which
 * refreshes them. If the refresh token has expired, the user must
 * run `bsky login` again.
 */
export async function createClient(
  session: SessionConfig,
  profile?: string,
): Promise<AtpAgent> {
  // `-p <handle>` finds a session by its handle, and its tokens go back where they came from.
  const home = profile && (await findProfile(profile));
  const agent = new AtpAgent({
    service: session.host,
    // Every refresh spends the token before it, here or hours later in a REPL.
    persistSession: (event, data) => {
      if (event !== "update" || !data) return;
      const { did, handle, accessJwt, refreshJwt } = data;
      saveRefreshed({ ...session, did, handle, accessJwt, refreshJwt }, home);
    },
  });

  try {
    await agent.resumeSession({
      did: session.did,
      handle: session.handle,
      accessJwt: session.accessJwt,
      refreshJwt: session.refreshJwt,
      active: true,
    });
    return agent;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const { status } = err as { status?: number };
    if (isNetworkError(err) || (status ?? 0) >= 500 || status === 429) {
      throw new Error(`Can't reach ${session.host}: ${reason}`, { cause: err });
    }
    // The library drops the session only when the server refuses the token.
    if (agent.hasSession) throw new Error(`Couldn't sign in at ${session.host}: ${reason}`, { cause: err });
    throw new Error(
      "Session expired. Run 'bsky login' to re-authenticate.",
    );
  }
}
