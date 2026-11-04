import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Edit text in $EDITOR (or vi), through a temporary file. */
export async function editInEditor(text: string): Promise<string> {
  const editor = process.env.EDITOR || "vi";
  // ponytail: split on spaces, so a path with a space needs a wrapper script.
  const [command, ...args] = editor.split(/\s+/);
  const path = join(tmpdir(), `bsky-edit-${randomBytes(4).toString("hex")}.txt`);
  await writeFile(path, text, "utf-8");
  try {
    const { error, status, signal } = spawnSync(command, [...args, path], { stdio: "inherit" });
    if (error) throw new Error(`Couldn't open ${editor}: ${error.message}`);
    // Whatever it left in the file can't be trusted, so the caller keeps its text.
    if (signal) throw new Error(`${editor} was stopped by ${signal}`);
    if (status !== 0) throw new Error(`${editor} exited with status ${status}`);
    return (await readFile(path, "utf-8")).trimEnd();
  } finally {
    await rm(path, { force: true });
  }
}
