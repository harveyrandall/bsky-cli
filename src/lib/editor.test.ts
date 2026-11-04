import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editInEditor } from "@/lib/editor";

describe("editInEditor", () => {
  const saved = process.env.EDITOR;
  const dir = mkdtempSync(join(tmpdir(), "bsky-editor-"));
  afterEach(() => {
    process.env.EDITOR = saved;
  });
  const editor = (script: string) => {
    const path = join(dir, "editor.sh");
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
    process.env.EDITOR = path;
  };
  it("returns what the editor saved, without trailing whitespace", async () => {
    editor(`printf ' more\\n\\n' >> "$1"`);
    await expect(editInEditor("text")).resolves.toBe("text more");
  });
  it("passes on arguments in $EDITOR, as in `code --wait`", async () => {
    editor(`printf '%s' " $1" >> "$2"`);
    process.env.EDITOR += " --wait";
    await expect(editInEditor("text")).resolves.toBe("text --wait");
  });
  it("won't trust an editor that failed", async () => {
    editor(`printf 'half writ' > "$1"; exit 3`);
    await expect(editInEditor("text")).rejects.toThrow("exited with status 3");
  });
  it("won't trust an editor that was killed", async () => {
    editor(`printf 'half writ' > "$1"; kill -9 $$`);
    await expect(editInEditor("text")).rejects.toThrow("SIGKILL");
  });
  it("says so when the editor won't start", async () => {
    process.env.EDITOR = join(dir, "missing");
    await expect(editInEditor("text")).rejects.toThrow("missing");
    rmSync(dir, { recursive: true, force: true });
  });
});
