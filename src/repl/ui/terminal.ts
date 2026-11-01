const DA1_REPLY = /\x1b\[\?[\d;]*c/;
const KITTY_REPLY = /\x1b\[\?\d+u/;

/**
 * Ask whether the terminal speaks the kitty keyboard protocol (the only way
 * to tell Shift+Enter from Enter). The query is followed by DA1, which every
 * terminal answers, so we stop at that reply instead of waiting out a timer;
 * `timeoutMs` only covers terminals that answer nothing.
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
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      resolve(supported);
    };
    const onData = (chunk: Buffer | string) => {
      buffer += String(chunk);
      if (DA1_REPLY.test(buffer)) finish(KITTY_REPLY.test(buffer));
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    stdin.on("data", onData);
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write("\x1b[?u\x1b[c");
  });
}
