import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { createWriteStream } from "node:fs";
import { stdin, stdout, stderr } from "node:process";
import { authPath } from "@/config";
import type { AuthInfo, Config } from "@/lib/types";

export async function readAuth(
  handle: string,
  prefix: string = "",
): Promise<AuthInfo | null> {
  try {
    const fp = authPath(handle, prefix);
    const data = await readFile(fp, "utf-8");
    return JSON.parse(data) as AuthInfo;
  } catch {
    return null;
  }
}

export async function writeAuth(
  auth: AuthInfo,
  handle: string,
  prefix: string = "",
): Promise<void> {
  const fp = authPath(handle, prefix);
  await writeFile(fp, JSON.stringify(auth, null, "  ") + "\n", {
    mode: 0o600,
  });
}

export async function promptPassword(): Promise<string> {
  if (stdin.isTTY) {
    // Interactive: hide input by sending output to /dev/null
    stderr.write("Password: ");
    const muted = createWriteStream("/dev/null");
    const rl = createInterface({ input: stdin, output: muted });
    const password = await rl.question("");
    rl.close();
    stderr.write("\n");
    return password.trim();
  }

  // Piped: read a single line from stdin
  const rl = createInterface({ input: stdin });
  const password = await rl.question("");
  rl.close();
  return password.trim();
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
