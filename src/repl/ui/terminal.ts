const DA1_REPLY = /\x1b\[\?[\d;]*c/;
const KITTY_REPLY = /\x1b\[\?\d+u/;

/**
 * Ask whether the terminal speaks the kitty keyboard protocol (the only way
 * to tell Shift+Enter from Enter). The query is followed by DA1, which every
 * terminal answers, so we stop at that reply instead of waiting out a timer;
 * `timeoutMs` only covers terminals that answer nothing.
 *
 * Replies are read with `readable` + `read()`, as Ink reads: under Bun, a
 * `data` listener left stdin unread after the handoff and the REPL exited.
 */
export function detectKittyKeyboard(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  timeoutMs = 500,
): Promise<boolean> {
  return new Promise((resolve) => {
    let buffer = "";
    const finish = (supported: boolean) => {
      clearTimeout(timer);
      stdin.off("readable", onReadable);
      stdin.setRawMode(false);
      stdin.pause();
      resolve(supported);
    };
    const onReadable = () => {
      let chunk: Buffer | string | null;
      while ((chunk = stdin.read()) !== null) buffer += String(chunk);
      if (DA1_REPLY.test(buffer)) finish(KITTY_REPLY.test(buffer));
    };
    const timer = setTimeout(() => finish(KITTY_REPLY.test(buffer)), timeoutMs);
    stdin.on("readable", onReadable);
    stdin.setRawMode(true);
    stdout.write("\x1b[?u\x1b[c");
  });
}
