import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";

/**
 * Prompt for a password with secure input.
 *
 * Resolution chain (in login.ts, not here):
 *   1. CLI argument  →  2. BSKY_PASSWORD env  →  3. this function
 *
 * This function handles two cases:
 * - Piped stdin (!isTTY): reads a single line (e.g. echo "pw" | bsky login)
 * - Interactive TTY: uses raw mode to suppress keystroke echo at the
 *   kernel level, so the password is never visible on screen.
 */
export async function promptPassword(): Promise<string> {
  if (!stdin.isTTY) {
    // Piped input — read a single line from stdin
    const rl = createInterface({ input: stdin });
    const password = await rl.question("");
    rl.close();
    return password.trim();
  }

  // Interactive TTY: disable echo at the kernel level
  stderr.write("Password: ");
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf-8");

  return new Promise<string>((resolve) => {
    let password = "";

    const onData = (chunk: string) => {
      for (const char of chunk) {
        // Enter → done
        if (char === "\r" || char === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          stderr.write("\n");
          resolve(password.trim());
          return;
        }

        // Ctrl+C → abort
        if (char === "\u0003") {
          stdin.setRawMode(false);
          stdin.pause();
          stderr.write("\n");
          process.exit(1);
        }

        // Ctrl+D → done (EOF)
        if (char === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          stderr.write("\n");
          resolve(password.trim());
          return;
        }

        // Backspace / Delete
        if (char === "\u007F" || char === "\b") {
          password = password.slice(0, -1);
          continue;
        }

        // Skip other control characters
        if (char.charCodeAt(0) < 32) continue;

        password += char;
      }
    };

    stdin.on("data", onData);
  });
}

export async function prompt2FA(): Promise<string> {
  stderr.write(
    "2FA is enabled. A sign-in code has been sent to your email.\nEnter the code: ",
  );
  const rl = createInterface({ input: stdin, output: stdout });
  const code = await rl.question("");
  rl.close();
  return code.trim();
}
