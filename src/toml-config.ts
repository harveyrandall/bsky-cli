import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { Command } from "commander";
import { bskyDir } from "@/config";

// Keys in TOML that use a readable name but map to a different Commander attribute
const OPTION_KEY_MAP: Record<string, Record<string, string>> = {
  timeline: { count: "n" },
  thread: { count: "n" },
  search: { count: "n" },
  "search-users": { count: "n" },
  "schedule list": { count: "number" },
  "bookmarks get": { count: "count" },
};

// TOML keys that are negated booleans (no-X = true → X = false in Commander)
const NEGATED_KEYS = new Set(["no-preview"]);

// Env vars that override config values (env key → config key)
const ENV_OVERRIDES: Record<string, string> = {
  BSKY_PROFILE: "profile",
};

/**
 * Resolve the config file path.
 * Uses the override path if provided, otherwise the default location.
 */
export function configFilePath(overridePath?: string): string {
  if (overridePath) return overridePath;
  return join(bskyDir(), "config.toml");
}

/**
 * Load and parse a TOML config file.
 * Returns an empty object if the file doesn't exist.
 * Throws on parse errors with a clear message.
 */
export function loadTomlConfig(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};

  const content = readFileSync(filePath, "utf-8");
  try {
    return parse(content) as Record<string, unknown>;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse config file ${filePath}: ${msg}`);
  }
}

/**
 * Apply parsed TOML config values to a Commander program.
 * Uses setOptionValueWithSource so CLI args (source 'cli') take precedence.
 */
export function applyConfigToProgram(
  program: Command,
  config: Record<string, unknown>,
): void {
  // Apply top-level keys as global options
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      // This is a [command] section — handle below
      continue;
    }
    applyOptionToCommand(program, key, value);
  }

  // Apply [command] sections
  for (const [cmdName, section] of Object.entries(config)) {
    if (typeof section !== "object" || section === null || Array.isArray(section)) {
      continue;
    }

    const cmd = program.commands.find(
      (c) => c.name() === cmdName || c.aliases().includes(cmdName),
    );
    if (!cmd) continue;

    const sectionRecord = section as Record<string, unknown>;

    for (const [key, value] of Object.entries(sectionRecord)) {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        // Nested subcommand: [schedule.list] → schedule → list
        const subCmd = cmd.commands.find(
          (c) => c.name() === key || c.aliases().includes(key),
        );
        if (!subCmd) continue;

        const subSection = value as Record<string, unknown>;
        const mapKey = `${cmdName} ${key}`;
        for (const [subKey, subValue] of Object.entries(subSection)) {
          applyOptionToCommand(subCmd, subKey, subValue, mapKey);
        }
      } else {
        applyOptionToCommand(cmd, key, value, cmdName);
      }
    }
  }
}

function applyOptionToCommand(
  cmd: Command,
  tomlKey: string,
  value: unknown,
  mapContext?: string,
): void {
  // Check env var override — skip config value if env var is set
  for (const [envKey, configKey] of Object.entries(ENV_OVERRIDES)) {
    if (tomlKey === configKey && process.env[envKey]) {
      return;
    }
  }

  // Handle negated booleans: no-preview = true → preview = false
  if (NEGATED_KEYS.has(tomlKey)) {
    const positiveKey = tomlKey.replace(/^no-/, "");
    cmd.setOptionValueWithSource(positiveKey, !value, "config");
    return;
  }

  // Map TOML key to Commander attribute name
  const keyMap = mapContext ? OPTION_KEY_MAP[mapContext] : undefined;
  const attrName = keyMap?.[tomlKey] ?? camelCase(tomlKey);

  cmd.setOptionValueWithSource(attrName, value, "config");
}

/** Convert kebab-case to camelCase (e.g. "thread-label" → "threadLabel") */
function camelCase(str: string): string {
  return str.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Generate the default config.toml content.
 * All values are commented out, serving as documentation.
 */
export function generateDefaultConfig(): string {
  return `# bsky-cli configuration
# CLI flags always override these values.
# Uncomment and modify options as needed.

# ── Global ──────────────────────────────────────
# json = false
# profile = ""
# verbose = false

# ── Commands ────────────────────────────────────

[post]
# stdin = false
# draft = false

[reply]
# draft = false

[quote]
# draft = false

[create-thread]
# stdin = false
# draft = false
# thread-label = false
# prepend-thread-label = false
# no-preview = false
# skip-validation = false
# media-all = false

[timeline]
# count = 30

[stream]
# pattern-flags = "gi"

[search]
# count = 100

[search-users]
# count = 100

[thread]
# count = 30

[notifs]
# all = false

[login]
# host = "https://bsky.social"
# bgs = "https://bsky.network"

[invite-codes]
# used = false

[mod-list]
# name = "NewList"
# desc = ""

[bookmarks.get]
# count = 50

[schedule.list]
# count = 5
# order = "asc"

[schedule.watch]
# interval = "* * * * *"

[schedule.enable]
# interval = 1

[schedule.post]
# stdin = false
`;
}
