import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Edit text in $EDITOR (or vi), through a temporary file. */
export async function editInEditor(text: string): Promise<string> {
  const editor = process.env.EDITOR || "vi";
  const path = join(tmpdir(), `bsky-edit-${randomBytes(4).toString("hex")}.txt`);
  await writeFile(path, text, "utf-8");
  try {
    const { error } = spawnSync(editor, [path], { stdio: "inherit" });
    if (error) throw new Error(`Couldn't open ${editor}: ${error.message}`);
    return (await readFile(path, "utf-8")).trimEnd();
  } finally {
    await rm(path, { force: true });
  }
}
