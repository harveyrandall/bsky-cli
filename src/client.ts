import { AtpAgent } from "@atproto/api";
import chalk from "chalk";
import { findProfile, savedSession, saveSessionConfig, sessionPath } from "@/config";
import { isNetworkError } from "@/lib/errors";
import type { SessionConfig } from "@/lib/types";

const clients = new Map<string, AtpAgent>();

/**
 * One sign-in per profile while its session lasts, however often a process asks: the
 * REPL runs CLI commands all session, and each new sign-in from the session file would
 * spend the refresh token the REPL's agent holds. Everyone gets a clone, which shares
 * the session but can set its own proxy.
 */
export async function sharedClient(profile: string | undefined, signIn: () => Promise<AtpAgent>): Promise<AtpAgent> {
  const known = clients.get(profile ?? "");
  if (known?.hasSession) return known.clone();
  const agent = await signIn();
  clients.set(profile ?? "", agent);
  return agent.clone();
}

/** Must not throw: the refresh has worked by now, but a throw would fail the sign-in, or the request that set it off. */
function saveRefreshed(session: SessionConfig, profile?: string): boolean {
  // A session can outlive its place in the file: `bsky login` in another terminal, say.
  const owner = savedSession(profile)?.did;
  if (owner && owner !== session.did) {
    console.error(chalk.yellow("Another account has logged in to this profile, so this session's tokens weren't saved"));
    return false;
  }
  try {
    saveSessionConfig(session, profile);
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(chalk.yellow(`Couldn't save your session to ${sessionPath(profile)}: ${reason}. Fix that, or you'll have to log in again.`));
    return false;
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
  let lastSaved = session.refreshJwt;
  const agent = new AtpAgent({
    service: session.host,
    // Another process using this login spends the token held here, and leaves the next in
    // the file. If this one's own save failed, the file is the older of the two.
    fetch: (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.endsWith("/xrpc/com.atproto.server.refreshSession")) return globalThis.fetch(input, init);
      const saved = savedSession(home);
      if (saved?.did !== session.did || !saved.refreshJwt || saved.refreshJwt === lastSaved) return globalThis.fetch(input, init);
      const request = new Request(input, init);
      request.headers.set("authorization", `Bearer ${saved.refreshJwt}`);
      return globalThis.fetch(request);
    },
    // Every refresh spends the token before it, here or hours later in a REPL.
    persistSession: (event, data) => {
      if (event !== "update" || !data) return;
      const { did, handle, accessJwt, refreshJwt } = data;
      if (saveRefreshed({ ...session, did, handle, accessJwt, refreshJwt }, home)) lastSaved = refreshJwt;
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
