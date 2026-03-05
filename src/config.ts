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

  let cfg: Config = {
    host: "https://bsky.social",
    bgs: "https://bsky.network",
    handle: "",
    password: "",
  };

  try {
    const data = await readFile(fp, "utf-8");
    const fileCfg: Partial<Config> = JSON.parse(data);
    cfg = { ...cfg, ...fileCfg };
  } catch {
    // No config file — env vars or login required
  }

  // Env vars override config file values
  if (process.env.BSKY_HANDLE) cfg.handle = process.env.BSKY_HANDLE;
  if (process.env.BSKY_PASSWORD) cfg.password = process.env.BSKY_PASSWORD;
  if (process.env.BSKY_HOST) cfg.host = process.env.BSKY_HOST;
  if (process.env.BSKY_BGS) cfg.bgs = process.env.BSKY_BGS;

  if (!cfg.handle || !cfg.password) {
    throw new Error(
      "No credentials found. Run 'bsky login' or set BSKY_HANDLE and BSKY_PASSWORD.",
    );
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
