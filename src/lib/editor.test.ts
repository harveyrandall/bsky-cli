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
  it("says so when the editor won't start", async () => {
    process.env.EDITOR = join(dir, "missing");
    await expect(editInEditor("text")).rejects.toThrow("missing");
    rmSync(dir, { recursive: true, force: true });
  });
});
