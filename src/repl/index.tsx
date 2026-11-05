import { basename } from "node:path";
import { render, renderToString } from "ink";
import { LaunchList } from "@/repl/ui/LaunchList";
import { deleteDraft, readDrafts, saveDraft } from "@/drafts";
import { setPostLabeler } from "@/lib/format";
import { getSchedulerStatus, schedulerProfile } from "@/lib/scheduler";
import { saveScheduledPost } from "@/scheduled";
import { setConfigValues } from "@/toml-config";
import { App, LEFT, type AppProps } from "@/repl/ui/App";
import { DEFAULT_MARKERS, type Markers } from "@/repl/core/markers";
import type { ReplSessionFile, SessionListing, SessionStore } from "@/repl/core/persist";
import { SessionKeeper } from "@/repl/core/session";
import type { Repl, ReplAgent, ReplSettings } from "@/repl/core/repl";
import { exitSummary } from "@/repl/core/summary";
import type { Did, Handle, IsoUtc, SessionId } from "@/repl/core/types";
import { outsideCommands } from "@/repl/core/passthrough";
import { detectKittyKeyboard } from "@/repl/ui/terminal";

export interface ReplOptions {
  markers: Markers;
  settings: ReplSettings;
  agent: ReplAgent;
  handle: string;
  /** The config file the save offer writes to. */
  configPath: string;
  profile?: string;
  passthrough?: AppProps["passthrough"];
  /** `/switch`: the account behind a profile. */
  switchAccount?(profile: string): Promise<{ agent: ReplAgent; handle: Handle; profile: string }>;
  session?: {
    store: Pick<SessionStore, "save" | "delete" | "lock" | "unlock" | "prune">;
    id: SessionId;
    createdAt: IsoUtc;
    did: Did;
    /** Sessions to keep when pruning. */
    keep: number;
    resume?: ReplSessionFile;
    /** Flags that a resumed session's own settings overrule, with what to run instead. */
    ignoredFlags?: readonly string[];
  };
}

/** The launch list: an id to open, undefined for a new session, null to quit. */
export async function pickSession(store: Pick<SessionStore, "delete">, listings: readonly SessionListing[]): Promise<SessionId | undefined | null> {
  let picked: string | undefined | null;
  const app = render(
    <LaunchList
      listings={listings}
      onDelete={(id) => store.delete(id)}
      onPick={(id) => {
        picked = id;
        app.unmount();
      }}
    />,
    { exitOnCtrlC: false },
  );
  await app.waitUntilExit();
  // Ink lets go of stdin, and a readline question after it (offline drafts) would otherwise end the process.
  process.stdin.ref();
  return picked as SessionId | undefined | null;
}

/** There's one job per machine, and it only sends one profile's posts. */
function schedulerRunning(profile?: string): boolean {
  try {
    return getSchedulerStatus() === "enabled" && (schedulerProfile() ?? "") === (profile ?? "");
  } catch {
    return false; // an unsupported platform: nothing runs by itself
  }
}

export async function startRepl(opts: ReplOptions): Promise<void> {
  // Probing ourselves rather than using Ink's `mode: "auto"`: that waits a fixed
  // 200 ms and doesn't report the answer, which the hint needs. Ink enables the
  // protocol, and restores it on every exit path, when told it's supported.
  const kitty = await detectKittyKeyboard(process.stdin, process.stdout);
  const session = opts.session;
  // /switch changes these.
  let { profile } = opts;
  const handles = new Set([opts.handle]);
  const startedAt = session?.resume ? new Date(session.createdAt) : new Date();
  let repl: Repl | undefined;
  const keeper =
    session &&
    new SessionKeeper(
      session.store,
      { id: session.id, createdAt: session.createdAt, handle: opts.handle as Handle, did: session.did, profile: opts.profile },
      session.keep,
      session.resume,
    );
  const app = render(
    <App
      markers={opts.markers}
      kittyHint={!kitty}
      settings={opts.settings}
      agent={opts.agent}
      drafts={{ save: (d) => saveDraft(d, profile), delete: (id) => deleteDraft(id, profile) }}
      saveConfig={(values) => setConfigValues(opts.configPath, "repl", values)}
      saveScheduled={(p) => saveScheduledPost(p, profile)}
      schedulerRunning={() => schedulerRunning(profile)}
      listDrafts={() => readDrafts(profile)}
      switchAccount={async (name) => {
        if (!opts.switchAccount) throw new Error("Can't switch accounts here");
        const next = await opts.switchAccount(name);
        profile = next.profile;
        handles.add(next.handle);
        keeper?.setAccount({ handle: next.handle, did: next.agent.selfDid, profile: profile || undefined });
        return next;
      }}
      keeper={keeper}
      resume={session?.resume}
      ignoredFlags={session?.ignoredFlags}
      passthrough={opts.passthrough}
      configName={basename(opts.configPath)}
      onReady={(r) => {
        repl = r;
        setPostLabeler((post) => r.labelPost(post));
      }}
    />,
    { exitOnCtrlC: false, kittyKeyboard: { mode: kitty ? "enabled" : "disabled" }, stdout: outsideCommands(process.stdout) },
  );
  // Ink restores the terminal on an uncaught error under Node but not under
  // Bun, which left the shell in kitty and bracketed-paste mode. Unmounting
  // restores it everywhere; the error is rethrown once Ink has exited, since
  // the instance's unmount() takes no error.
  let crashed: Error | undefined;
  const crash = (err: unknown) => {
    crashed ??= err instanceof Error ? err : new Error(String(err));
    app.unmount();
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  let left = false;
  let resumable = false;
  try {
    // Ink also stops by itself when stdin closes; say so rather than exit as if asked to.
    const result = await app.waitUntilExit();
    left = result === LEFT;
    if (crashed) throw crashed;
    if (!left) {
      process.stderr.write("bsky repl stopped because its input closed.\n");
      process.exitCode = 1;
    }
  } finally {
    // However Ink stopped, nothing may be posted after the REPL has gone.
    if (repl && keeper) {
      const end = await keeper.end(repl, left);
      resumable = end.resumable;
      if (end.error) process.stderr.write(`Couldn't save this session (${end.error})\n`);
    } else if (repl) {
      repl.close();
      if (left) await repl.settled();
    }
    setPostLabeler(undefined);
    process.off("uncaughtException", crash);
    process.off("unhandledRejection", crash);
  }
  if (repl) {
    const lines = exitSummary({
      registry: repl.registry,
      failures: repl.failures(),
      verbose: repl.isVerbose(),
      startedAt,
      endedAt: new Date(),
      handle: [...handles].join(", @"),
      resumeId: resumable ? session?.id : undefined,
    });
    for (const line of lines) process.stdout.write(`${line}\n`);
  }
}

const offline = async (): Promise<never> => {
  throw new Error("Not connected");
};

/** Props for a frame with no account behind it: the smoke run and tests. */
export const offlineProps: Omit<AppProps, "markers" | "kittyHint"> = {
  settings: { autoThread: false, prefixThread: false, threadLabel: false, undo: 0, pace: 0, askToSave: false, verbose: false, forceAlt: false },
  agent: { selfDid: "did:plc:offline", resolveHandle: offline, getPosts: offline, post: offline, like: offline, unlike: offline, repost: offline, unrepost: offline, deletePost: offline, signedIn: () => false },
  drafts: { save: offline, delete: offline },
  saveConfig: offline,
  saveScheduled: offline,
  schedulerRunning: () => false,
  listDrafts: offline,
  switchAccount: offline,
  configName: "config.toml",
};

/** One frame without a TTY, so CI can prove Ink loads under Node and Bun. */
export function smokeFrame(): string {
  return renderToString(<App markers={DEFAULT_MARKERS} kittyHint={false} {...offlineProps} />);
}
