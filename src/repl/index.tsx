import { basename } from "node:path";
import { render, renderToString } from "ink";
import type { EditorState } from "@/repl/ui/editor";
import { LaunchList } from "@/repl/ui/LaunchList";
import { deleteDraft, saveDraft } from "@/drafts";
import { getSchedulerStatus } from "@/lib/scheduler";
import { saveScheduledPost } from "@/scheduled";
import { setConfigValues } from "@/toml-config";
import { App, LEFT, type AppProps } from "@/repl/ui/App";
import { emptyEditor } from "@/repl/ui/editor";
import { DEFAULT_MARKERS, type Markers } from "@/repl/core/markers";
import { isEmptySession, type ReplSessionFile, type SessionListing, type SessionStore } from "@/repl/core/persist";
import type { Repl, ReplAgent, ReplSettings } from "@/repl/core/repl";
import { exitSummary } from "@/repl/core/summary";
import type { Did, Handle, IsoUtc, SessionId } from "@/repl/core/types";
import { detectKittyKeyboard } from "@/repl/ui/terminal";

export interface ReplOptions {
  markers: Markers;
  settings: ReplSettings;
  agent: ReplAgent;
  handle: string;
  /** The config file the save offer writes to. */
  configPath: string;
  profile?: string;
  session?: {
    store: Pick<SessionStore, "save" | "delete" | "lock" | "unlock" | "prune">;
    id: SessionId;
    createdAt: IsoUtc;
    did: Did;
    /** Sessions to keep when pruning. */
    keep: number;
    /** False with -R: nothing is written. */
    saving: boolean;
    resume?: ReplSessionFile;
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
  return picked as SessionId | undefined | null;
}

function schedulerRunning(): boolean {
  try {
    return getSchedulerStatus() === "enabled";
  } catch {
    return false; // an unsupported platform: nothing runs by itself
  }
}

export async function startRepl(opts: ReplOptions): Promise<void> {
  // Probing ourselves rather than using Ink's `mode: "auto"`: that waits a fixed
  // 200 ms and doesn't report the answer, which the hint needs. Ink enables the
  // protocol, and restores it on every exit path, when told it's supported.
  const kitty = await detectKittyKeyboard(process.stdin, process.stdout);
  const startedAt = new Date();
  let repl: Repl | undefined;
  const session = opts.session;
  // A resumed session was locked before it opened; a new id is ours until there's a file to protect.
  let locked = session?.resume !== undefined;
  let latest: EditorState = emptyEditor(session?.resume?.history);
  const toFile = (r: Repl, c: Pick<EditorState, "text" | "cursor" | "history">) =>
    r.snapshot(
      { id: session!.id, createdAt: session!.createdAt, handle: opts.handle as Handle, did: session!.did, profile: opts.profile },
      { text: c.text, cursor: c.cursor },
      c.history,
    );
  const write = async (file: ReplSessionFile) => {
    if (isEmptySession(file)) return;
    if (!locked) locked = await session!.store.lock(session!.id);
    await session!.store.save(file);
  };
  const saveSession = (r: Repl, c: EditorState) => {
    latest = c;
    return write(toFile(r, c));
  };
  /** True if there's something to come back to. */
  const endSession = async (r: Repl, left: boolean): Promise<boolean> => {
    const { store, id, saving, keep } = session!;
    if (!saving) {
      await store.unlock(id);
      return false;
    }
    // Leaving dealt with what was unsent; anything else keeps it for next time.
    const file = toFile(r, left ? { ...latest, text: "", cursor: 0 } : latest);
    if (isEmptySession(file)) await store.delete(id);
    else await write(file);
    await store.unlock(id);
    await store.prune(keep);
    return !isEmptySession(file);
  };
  const app = render(
    <App
      markers={opts.markers}
      kittyHint={!kitty}
      settings={opts.settings}
      agent={opts.agent}
      drafts={{ save: (d) => saveDraft(d, opts.profile), delete: (id) => deleteDraft(id, opts.profile) }}
      saveConfig={(values) => setConfigValues(opts.configPath, "repl", values)}
      saveScheduled={(p) => saveScheduledPost(p, opts.profile)}
      schedulerRunning={schedulerRunning}
      saveSession={session?.saving ? saveSession : undefined}
      resume={session?.resume}
      configName={basename(opts.configPath)}
      onReady={(r) => (repl = r)}
    />,
    { exitOnCtrlC: false, kittyKeyboard: { mode: kitty ? "enabled" : "disabled" } },
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
    process.off("uncaughtException", crash);
    process.off("unhandledRejection", crash);
    if (repl && session) resumable = await endSession(repl, left).catch(() => false);
    // However Ink stopped, nothing may be posted after the REPL has gone.
    repl?.close();
  }
  if (repl) {
    const lines = exitSummary({
      registry: repl.registry,
      failures: repl.failures(),
      verbose: opts.settings.verbose,
      startedAt,
      endedAt: new Date(),
      handle: opts.handle,
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
  agent: { selfDid: "did:plc:offline", resolveHandle: offline, getPosts: offline, post: offline },
  drafts: { save: offline, delete: offline },
  saveConfig: offline,
  saveScheduled: offline,
  schedulerRunning: () => false,
  configName: "config.toml",
};

/** One frame without a TTY, so CI can prove Ink loads under Node and Bun. */
export function smokeFrame(): string {
  return renderToString(<App markers={DEFAULT_MARKERS} kittyHint={false} {...offlineProps} />);
}
