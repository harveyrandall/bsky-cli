import { readFileSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  "dm list": { count: "count" },
  "dm read": { count: "count" },
};

// TOML keys that are negated booleans (no-X = true → X = false in Commander)
const NEGATED_KEYS = new Set(["no-preview"]);

// Env vars that override config values (env key → config key)
const ENV_OVERRIDES: Record<string, string> = {
  BSKY_PROFILE: "profile",
};

/**
 * Resolve the config file path.
 * Precedence: overridePath (-c flag) > BSKY_CONFIG env var > default location.
 */
export function configFilePath(overridePath?: string): string {
  if (overridePath) return overridePath;
  if (process.env.BSKY_CONFIG) return process.env.BSKY_CONFIG;
  return join(bskyDir(), "config.toml");
}

/** The config file this run uses: -c/--config from argv, then the usual lookup. */
export function activeConfigPath(argv: string[] = process.argv): string {
  for (const [i, arg] of argv.entries()) {
    if (arg === "--") break;
    if (arg === "--config" || arg === "-c") return configFilePath(argv[i + 1]);
    const joined = /^(?:--config=|-c)(.+)$/.exec(arg);
    if (joined) return configFilePath(joined[1]);
  }
  return configFilePath();
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The comment after a `key = value` line's value. */
const TRAILING_COMMENT = /^[^=]*=\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^#\s]*)(\s*#.*)$/;

/** Replace a file in one step, through a symlink and keeping its permissions. */
function replaceFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const exists = existsSync(path);
  const target = exists ? realpathSync(path) : path;
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, exists ? { mode: statSync(target).mode } : {});
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Set keys in one section of a TOML file without disturbing anything else.
 * Line-based on purpose: a parse-and-stringify round trip would delete every
 * comment, including the documentation `bsky config init` writes. Inside the
 * section it replaces `key = …` or uncomments `# key = …`, else inserts after
 * the header; a missing section is appended and a missing file starts from the
 * default config. The result must parse before it replaces the file.
 */
export async function setConfigValues(
  path: string,
  section: string,
  values: Record<string, string | number | boolean>,
): Promise<void> {
  const lines = (existsSync(path) ? readFileSync(path, "utf-8") : generateDefaultConfig()).split("\n");
  const isHeader = new RegExp(`^\\s*\\[\\s*${escapeRegExp(section)}\\s*\\]\\s*(#.*)?$`);
  for (const [key, value] of Object.entries(values)) {
    const line = `${key} = ${typeof value === "string" ? JSON.stringify(value) : String(value)}`;
    const header = lines.findIndex((l) => isHeader.test(l));
    if (header === -1) {
      if (lines[lines.length - 1] === "") lines.pop();
      lines.push("", `[${section}]`, line, "");
      continue;
    }
    const next = lines.findIndex((l, i) => i > header && /^\s*\[/.test(l));
    const end = next === -1 ? lines.length : next;
    const isKey = new RegExp(`^\\s*(#\\s*)?${escapeRegExp(key)}\\s*=`);
    const inSection = (want: "set" | "commented") => (l: string, i: number) =>
      i > header && i < end && isKey.test(l) && (want === "commented") === /^\s*#/.test(l);
    const at = lines.findIndex(inSection("set"));
    const commented = lines.findIndex(inSection("commented"));
    if (at !== -1) lines[at] = line + (TRAILING_COMMENT.exec(lines[at])?.[1] ?? "");
    else if (commented !== -1) lines[commented] = line;
    else lines.splice(header + 1, 0, line);
  }
  const text = lines.join("\n");
  try {
    parse(text); // throws, leaving the file untouched
    replaceFile(path, text);
  } catch (err) {
    throw new Error(`Couldn't update ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
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

[repl]
# auto-thread = false
# prefix-thread = false
# undo and pace take 0, 5, 10 or 15 (seconds); left unset, the first thread asks
# undo = 5
# pace = 0
# force-alt = false
# thread-label = false
# prepend-thread-label = false
# ask-to-save = true
# resumable = true
# keep-sessions = 50
# split-marker = "///"
# send-marker = "//>"
# cut-marker = "<//"

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

[dm.list]
# count = 50

[dm.read]
# count = 30
`;
}
