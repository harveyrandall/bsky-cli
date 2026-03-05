import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { readdirSync } from "node:fs";
import type { Config } from "@/lib/types";

function configDir(): string {
  return join(homedir(), ".config");
}

function bskyDir(): string {
  return join(configDir(), "bsky");
}

export function configPath(profile?: string): string {
  if (profile) {
    return join(bskyDir(), `config-${profile}.json`);
  }
  return join(bskyDir(), "config.json");
}

export function authPath(handle: string, prefix: string = ""): string {
  return join(bskyDir(), `${prefix}${handle}.auth`);
}

export async function loadConfig(profile?: string): Promise<Config> {
  if (profile === "?") {
    listProfiles();
    process.exit(0);
  }

  const fp = configPath(profile);
  await mkdir(dirname(fp), { recursive: true });

  const data = await readFile(fp, "utf-8");
  const cfg: Config = JSON.parse(data);

  if (!cfg.host) {
    cfg.host = "https://bsky.social";
  }

  return cfg;
}

export async function saveConfig(
  config: Config,
  profile?: string,
): Promise<void> {
  const fp = configPath(profile);
  await mkdir(dirname(fp), { recursive: true });
  await writeFile(fp, JSON.stringify(config, null, "  ") + "\n", {
    mode: 0o644,
  });
}

function listProfiles(): void {
  const dir = bskyDir();
  if (!existsSync(dir)) return;

  const files = readdirSync(dir);
  for (const file of files) {
    if (file.startsWith("config-") && file.endsWith(".json")) {
      const name = file.slice(7, -5);
      console.log(name);
    }
  }
}
