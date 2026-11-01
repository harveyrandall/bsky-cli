import { render, renderToString } from "ink";
import { App } from "@/repl/ui/App";
import { DEFAULT_MARKERS, type Markers } from "@/repl/core/markers";

export interface ReplOptions {
  markers: Markers;
}

export async function startRepl(opts: ReplOptions): Promise<void> {
  const app = render(<App markers={opts.markers} kittyHint={false} />, { exitOnCtrlC: false });
  await app.waitUntilExit();
}

/** One frame without a TTY, so CI can prove Ink loads under Node and Bun. */
export function smokeFrame(): string {
  return renderToString(<App markers={DEFAULT_MARKERS} kittyHint={false} />);
}
