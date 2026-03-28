import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { bskyDir } from "@/config";

export type SchedulerState = "enabled" | "disabled" | "not installed";

const CRONTAB_MARKER = "# bsky-cli-scheduler";
const LAUNCHD_LABEL = "com.bsky-cli.scheduler";
const LAUNCHD_PLIST = join(
  homedir(),
  "Library",
  "LaunchAgents",
  `${LAUNCHD_LABEL}.plist`,
);
const SCHTASKS_NAME = "BskyCLI\\ScheduleRun";

export function resolveBskyPath(): string {
  return resolve(process.argv[1]);
}

// ── Linux (crontab) ──────────────────────────────────────────────────

function readCrontab(): string {
  try {
    return execFileSync("crontab", ["-l"], { encoding: "utf-8" });
  } catch {
    return "";
  }
}

function writeCrontab(content: string): void {
  execFileSync("crontab", ["-"], { input: content, encoding: "utf-8" });
}

function enableLinux(interval: number, bskyPath: string, profile?: string): void {
  const existing = readCrontab();
  const filtered = existing
    .split("\n")
    .filter((l) => !l.includes(CRONTAB_MARKER))
    .join("\n");
  const profileFlag = profile ? ` -p '${profile}'` : "";
  const cronExpr = interval === 1 ? "* * * * *" : `*/${interval} * * * *`;
  const newLine = `${cronExpr} ${bskyPath} schedule run${profileFlag} ${CRONTAB_MARKER}`;
  const updated = filtered.trimEnd() + "\n" + newLine + "\n";
  writeCrontab(updated);
}

function disableLinux(): void {
  const existing = readCrontab();
  const lines = existing.split("\n").map((l) => {
    if (l.includes(CRONTAB_MARKER) && !l.startsWith("# DISABLED ")) {
      return `# DISABLED ${l}`;
    }
    return l;
  });
  writeCrontab(lines.join("\n"));
}

function statusLinux(): SchedulerState {
  const existing = readCrontab();
  const line = existing.split("\n").find((l) => l.includes(CRONTAB_MARKER));
  if (!line) return "not installed";
  if (line.startsWith("# DISABLED ")) return "disabled";
  return "enabled";
}

function uninstallLinux(): void {
  const existing = readCrontab();
  const filtered = existing
    .split("\n")
    .filter((l) => !l.includes(CRONTAB_MARKER))
    .join("\n");
  writeCrontab(filtered);
}

// ── macOS (launchd) ──────────────────────────────────────────────────

function buildPlist(interval: number, bskyPath: string, profile?: string): string {
  const args = [bskyPath, "schedule", "run"];
  if (profile) args.push("--profile", profile);

  const argsXml = args.map((a) => `        <string>${a}</string>`).join("\n");
  const logPath = join(bskyDir(), "scheduler.log");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>StartInterval</key>
    <integer>${interval * 60}</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${logPath}</string>
    <key>StandardErrorPath</key>
    <string>${logPath}</string>
</dict>
</plist>
`;
}

function enableMacOS(interval: number, bskyPath: string, profile?: string): void {
  // Unload first if already loaded (ignore errors)
  if (existsSync(LAUNCHD_PLIST)) {
    try {
      execFileSync("launchctl", ["unload", LAUNCHD_PLIST]);
    } catch {
      // Not loaded — fine
    }
  }

  writeFileSync(LAUNCHD_PLIST, buildPlist(interval, bskyPath, profile));
  execFileSync("launchctl", ["load", LAUNCHD_PLIST]);
}

function disableMacOS(): void {
  try {
    execFileSync("launchctl", ["unload", LAUNCHD_PLIST]);
  } catch {
    // Already unloaded
  }
}

function statusMacOS(): SchedulerState {
  if (!existsSync(LAUNCHD_PLIST)) return "not installed";
  try {
    execFileSync("launchctl", ["list", LAUNCHD_LABEL], { stdio: "pipe" });
    return "enabled";
  } catch {
    return "disabled";
  }
}

function uninstallMacOS(): void {
  try {
    execFileSync("launchctl", ["unload", LAUNCHD_PLIST]);
  } catch {
    // Not loaded
  }
  if (existsSync(LAUNCHD_PLIST)) {
    unlinkSync(LAUNCHD_PLIST);
  }
}

// ── Windows (schtasks) ───────────────────────────────────────────────

function enableWindows(interval: number, bskyPath: string, profile?: string): void {
  const profileFlag = profile ? ` -p "${profile}"` : "";
  const cmd = `"${bskyPath}" schedule run${profileFlag}`;
  execFileSync("schtasks", [
    "/create",
    "/tn",
    SCHTASKS_NAME,
    "/tr",
    cmd,
    "/sc",
    "minute",
    "/mo",
    String(interval),
    "/f",
  ]);
}

function disableWindows(): void {
  execFileSync("schtasks", ["/change", "/tn", SCHTASKS_NAME, "/disable"]);
}

function statusWindows(): SchedulerState {
  try {
    const output = execFileSync(
      "schtasks",
      ["/query", "/tn", SCHTASKS_NAME, "/v", "/fo", "LIST"],
      { encoding: "utf-8" },
    );
    if (output.includes("Disabled")) return "disabled";
    return "enabled";
  } catch {
    return "not installed";
  }
}

function uninstallWindows(): void {
  execFileSync("schtasks", ["/delete", "/tn", SCHTASKS_NAME, "/f"]);
}

// ── Public API (platform dispatch) ───────────────────────────────────

function unsupported(): never {
  console.error(`Unsupported platform: ${process.platform}`);
  process.exit(1);
}

export function enableScheduler(interval: number, profile?: string): void {
  const bskyPath = resolveBskyPath();
  switch (process.platform) {
    case "linux":
      return enableLinux(interval, bskyPath, profile);
    case "darwin":
      return enableMacOS(interval, bskyPath, profile);
    case "win32":
      return enableWindows(interval, bskyPath, profile);
    default:
      unsupported();
  }
}

export function disableScheduler(): void {
  switch (process.platform) {
    case "linux":
      return disableLinux();
    case "darwin":
      return disableMacOS();
    case "win32":
      return disableWindows();
    default:
      unsupported();
  }
}

export function getSchedulerStatus(): SchedulerState {
  switch (process.platform) {
    case "linux":
      return statusLinux();
    case "darwin":
      return statusMacOS();
    case "win32":
      return statusWindows();
    default:
      unsupported();
  }
}

export function uninstallScheduler(): void {
  switch (process.platform) {
    case "linux":
      return uninstallLinux();
    case "darwin":
      return uninstallMacOS();
    case "win32":
      return uninstallWindows();
    default:
      unsupported();
  }
}
