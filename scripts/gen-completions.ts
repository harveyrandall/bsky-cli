#!/usr/bin/env node
// scripts/gen-completions.ts
//
// Generates shell completions from the built CLI.
// Run: yarn build && yarn node scripts/gen-completions.ts
//
// Uses the built dist output to avoid ESM/CJS interop issues with
// source-level imports (rrule is CJS and fails with named imports
// under Node's native ESM loader).

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

const shells = ["bash", "zsh", "fish"] as const;

mkdirSync("completions", { recursive: true });

for (const shell of shells) {
  const output = execFileSync("node", ["dist/index.js", "completions", shell], {
    encoding: "utf-8",
  });
  const filename =
    shell === "zsh" ? "completions/_bsky" : `completions/bsky.${shell}`;
  writeFileSync(filename, output);
  console.log(`Generated ${filename}`);
}
