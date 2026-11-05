import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Replace a file in one step, through a symlink if its target exists (a dangling
 * link is replaced). Without `mode` it keeps the file's permissions, less the umask.
 */
export function replaceFile(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const exists = existsSync(path);
  const target = exists ? realpathSync(path) : path;
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: mode ?? (exists ? statSync(target).mode : undefined) });
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
