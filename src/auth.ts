import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { authPath } from "./config.js";
import type { AuthInfo, Config } from "./lib/types.js";

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

export async function prompt2FA(): Promise<string> {
  stderr.write(
    "2FA is enabled. A sign-in code has been sent to your email.\nEnter the code: ",
  );
  const rl = createInterface({ input: stdin, output: stdout });
  const code = await rl.question("");
  rl.close();
  return code.trim();
}
