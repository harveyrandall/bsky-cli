import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { readdirSync } from "node:fs";
import chalk from "chalk";
import type { Config, SessionConfig, AuthInfo } from "@/lib/types";

// ── Platform-appropriate config directory ────────────────────────────

export function bskyDir(): string {
  if (process.env.XDG_CONFIG_HOME) {
    return join(process.env.XDG_CONFIG_HOME, "bsky-cli");
  }

  switch (process.platform) {
    case "darwin":
      return join(
        homedir(),
        "Library",
        "Application Support",
        "bsky-cli",
      );
    case "win32":
      return join(
        process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
        "bsky-cli",
      );
    default:
      return join(homedir(), ".config", "bsky-cli");
  }
}

/** Legacy config directory (pre-v1.6) */
function legacyBskyDir(): string {
  return join(homedir(), ".config", "bsky");
}

// ── Session config paths ─────────────────────────────────────────────

export function sessionPath(profile?: string): string {
  if (profile) {
    return join(bskyDir(), `session-${profile}.json`);
  }
  return join(bskyDir(), "session.json");
}

/** @deprecated Legacy config path — used only for migration */
export function configPath(profile?: string): string {
  if (profile) {
    return join(legacyBskyDir(), `config-${profile}.json`);
  }
  return join(legacyBskyDir(), "config.json");
}

/** @deprecated Legacy auth path — used only for migration */
export function authPath(handle: string, prefix: string = ""): string {
  return join(legacyBskyDir(), `${prefix}${handle}.auth`);
}

// ── Migration from legacy format ─────────────────────────────────────

async function migrateIfNeeded(profile?: string): Promise<SessionConfig | null> {
  const legacyConfigFp = configPath(profile);
  if (!existsSync(legacyConfigFp)) return null;

  try {
    const raw = await readFile(legacyConfigFp, "utf-8");
    const legacy: Partial<Config> = JSON.parse(raw);

    if (!legacy.handle) return null;

    // Try reading the matching .auth file for session tokens
    const prefix = profile ? `${profile}-` : "";
    const legacyAuthFp = authPath(legacy.handle, prefix);
    let auth: AuthInfo | null = null;

    try {
      const authRaw = await readFile(legacyAuthFp, "utf-8");
      auth = JSON.parse(authRaw) as AuthInfo;
    } catch {
      // No auth file — migration can't proceed without tokens
      return null;
    }

    // Build new session config
    const session: SessionConfig = {
      host: legacy.host ?? "https://bsky.social",
      bgs: legacy.bgs ?? "https://bsky.network",
      handle: auth.handle,
      did: auth.did,
      accessJwt: auth.accessJwt,
      refreshJwt: auth.refreshJwt,
    };

    // Save to new location
    await saveSessionConfig(session, profile);

    // Rename old config (don't delete — keep as backup)
    await rename(legacyConfigFp, legacyConfigFp + ".bak").catch(() => {});

    if (legacy.password) {
      console.error(
        chalk.yellow(
          "⚠ Migrated to secure storage. Your old config contained a plaintext " +
            "password — it has been backed up and the password removed.",
        ),
      );
    } else {
      console.error(chalk.dim("Migrated config to new location."));
    }

    return session;
  } catch {
    return null;
  }
}

// ── Load / Save session config ───────────────────────────────────────

export async function loadSessionConfig(
  profile?: string,
): Promise<SessionConfig> {
  if (profile === "?") {
    listProfiles();
    process.exit(0);
  }

  const fp = sessionPath(profile);
  await mkdir(dirname(fp), { recursive: true });

  // Try loading from new location first
  try {
    const data = await readFile(fp, "utf-8");
    const session: SessionConfig = JSON.parse(data);

    // Env vars override stored values
    if (process.env.BSKY_HOST) session.host = process.env.BSKY_HOST;
    if (process.env.BSKY_BGS) session.bgs = process.env.BSKY_BGS;

    return session;
  } catch {
    // No session file — try migration
  }

  // Attempt migration from legacy config
  const migrated = await migrateIfNeeded(profile);
  if (migrated) return migrated;

  throw new Error(
    "No session found. Run 'bsky login' or set BSKY_HANDLE and BSKY_PASSWORD.",
  );
}

export async function saveSessionConfig(
  session: SessionConfig,
  profile?: string,
): Promise<void> {
  const fp = sessionPath(profile);
  await mkdir(dirname(fp), { recursive: true });
  await writeFile(fp, JSON.stringify(session, null, "  ") + "\n", {
    mode: 0o600,
  });
}

/** @deprecated Use saveSessionConfig — this persists passwords */
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

// ── Profile listing ──────────────────────────────────────────────────

function listProfiles(): void {
  // Check new location first
  const dir = bskyDir();
  if (existsSync(dir)) {
    const files = readdirSync(dir);
    for (const file of files) {
      if (file.startsWith("session-") && file.endsWith(".json")) {
        const name = file.slice(8, -5);
        console.log(name);
      }
    }
  }

  // Also check legacy location for unmigrated profiles
  const legacyDir = legacyBskyDir();
  if (existsSync(legacyDir)) {
    const files = readdirSync(legacyDir);
    for (const file of files) {
      if (file.startsWith("config-") && file.endsWith(".json")) {
        const name = file.slice(7, -5);
        // Only show if not already migrated
        if (!existsSync(sessionPath(name))) {
          console.log(chalk.dim(`${name} (legacy — run any command to migrate)`));
        }
      }
    }
  }
}
