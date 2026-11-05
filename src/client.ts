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
function saveRefreshed(session: SessionConfig, profile?: string): void {
  // A session can outlive its place in the file: `bsky login` in another terminal, say.
  const owner = savedSession(profile)?.did;
  if (owner && owner !== session.did) {
    console.error(chalk.yellow("Another account has logged in to this profile, so this session's tokens weren't saved"));
    return;
  }
  try {
    saveSessionConfig(session, profile);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(chalk.yellow(`Couldn't save your session to ${sessionPath(profile)}: ${reason}. Fix that, or you'll have to log in again.`));
  }
}

/** The server says this token is finished, by the same test the library drops a session on. */
async function refused(response: Response): Promise<boolean> {
  if (response.status === 401) return true;
  if (response.status !== 400) return false;
  const body = (await response.clone().json().catch(() => undefined)) as { error?: string } | undefined;
  return body?.error === "ExpiredToken" || body?.error === "InvalidToken";
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
    // Another process using this login spends the token held here, and leaves the next in
    // the file. That's only worth trying once the server refuses this one: the file can
    // hold something older, from a backup, say, and trusting it would end a good session.
    fetch: async (input, init) => {
      const own = await globalThis.fetch(input, init);
      const url = input instanceof Request ? input.url : String(input);
      if (!url.endsWith("/xrpc/com.atproto.server.refreshSession") || !(await refused(own))) return own;
      const saved = savedSession(home);
      const token = saved?.refreshJwt;
      if (saved?.did !== session.did || saved.host !== session.host || typeof token !== "string") return own;
      const request = new Request(input, init);
      if (request.headers.get("authorization") === `Bearer ${token}`) return own;
      try {
        request.headers.set("authorization", `Bearer ${token}`);
      } catch {
        return own; // not a token anyone issued
      }
      await own.body?.cancel();
      return globalThis.fetch(request);
    },
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
