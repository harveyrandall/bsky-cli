import { basename } from "node:path";
import { render, renderToString } from "ink";
import { deleteDraft, saveDraft } from "@/drafts";
import { setConfigValues } from "@/toml-config";
import { App, LEFT, type AppProps } from "@/repl/ui/App";
import { DEFAULT_MARKERS, type Markers } from "@/repl/core/markers";
import type { Repl, ReplAgent, ReplSettings } from "@/repl/core/repl";
import { exitSummary } from "@/repl/core/summary";
import { detectKittyKeyboard } from "@/repl/ui/terminal";

export interface ReplOptions {
  markers: Markers;
  settings: ReplSettings;
  agent: ReplAgent;
  handle: string;
  /** The config file the save offer writes to. */
  configPath: string;
  profile?: string;
}

export async function startRepl(opts: ReplOptions): Promise<void> {
  // Probing ourselves rather than using Ink's `mode: "auto"`: that waits a fixed
  // 200 ms and doesn't report the answer, which the hint needs. Ink enables the
  // protocol, and restores it on every exit path, when told it's supported.
  const kitty = await detectKittyKeyboard(process.stdin, process.stdout);
  const startedAt = new Date();
  let repl: Repl | undefined;
  const app = render(
    <App
      markers={opts.markers}
      kittyHint={!kitty}
      settings={opts.settings}
      agent={opts.agent}
      drafts={{ save: (d) => saveDraft(d, opts.profile), delete: (id) => deleteDraft(id, opts.profile) }}
      saveConfig={(values) => setConfigValues(opts.configPath, "repl", values)}
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
  try {
    // Ink also stops by itself when stdin closes; say so rather than exit as if asked to.
    const result = await app.waitUntilExit();
    if (crashed) throw crashed;
    if (result !== LEFT) {
      process.stderr.write("bsky repl stopped because its input closed.\n");
      process.exitCode = 1;
    }
  } finally {
    process.off("uncaughtException", crash);
    process.off("unhandledRejection", crash);
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
    });
    for (const line of lines) process.stdout.write(`${line}\n`);
  }
}

const offline = async (): Promise<never> => {
  throw new Error("Not connected");
};

/** Props for a frame with no account behind it: the smoke run and tests. */
export const offlineProps: Omit<AppProps, "markers" | "kittyHint"> = {
  settings: { autoThread: false, prefixThread: false, threadLabel: false, undo: 0, pace: 0, askToSave: false, verbose: false },
  agent: { selfDid: "did:plc:offline", resolveHandle: offline, getPosts: offline, post: offline },
  drafts: { save: offline, delete: offline },
  saveConfig: offline,
  configName: "config.toml",
};

/** One frame without a TTY, so CI can prove Ink loads under Node and Bun. */
export function smokeFrame(): string {
  return renderToString(<App markers={DEFAULT_MARKERS} kittyHint={false} {...offlineProps} />);
}
