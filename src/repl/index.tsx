import { render, renderToString } from "ink";
import { App } from "@/repl/ui/App";
import { DEFAULT_MARKERS, type Markers } from "@/repl/core/markers";
import { detectKittyKeyboard } from "@/repl/ui/terminal";

export interface ReplOptions {
  markers: Markers;
}

export async function startRepl(opts: ReplOptions): Promise<void> {
  // Ink enables the protocol, and restores it on every exit path, when told it's supported.
  const kitty = await detectKittyKeyboard(process.stdin, process.stdout);
  const app = render(<App markers={opts.markers} kittyHint={!kitty} />, {
    exitOnCtrlC: false,
    kittyKeyboard: { mode: kitty ? "enabled" : "disabled" },
  });
  // Ink restores the terminal on an uncaught error under Node but not under
  // Bun, which left the shell in kitty and bracketed-paste mode. Unmounting
  // restores it everywhere and rejects waitUntilExit with the error.
  const crash = (err: unknown) => app.unmount(err instanceof Error ? err : new Error(String(err)));
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  try {
    await app.waitUntilExit();
  } finally {
    process.off("uncaughtException", crash);
    process.off("unhandledRejection", crash);
  }
}

/** One frame without a TTY, so CI can prove Ink loads under Node and Bun. */
export function smokeFrame(): string {
  return renderToString(<App markers={DEFAULT_MARKERS} kittyHint={false} />);
}
