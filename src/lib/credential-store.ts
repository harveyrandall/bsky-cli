/**
 * OS keychain abstraction for secure session token storage.
 *
 * Tries platform-native credential storage first:
 * - macOS: Keychain Access via `security` CLI
 * - Linux: GNOME Keyring / libsecret via `secret-tool` CLI
 * - Windows: Windows Credential Manager via PowerShell
 *
 * Falls back to filesystem with 0o600 permissions when native
 * tools are unavailable (headless servers, containers, etc.).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SERVICE = "bsky-cli";

/**
 * Build a keychain key for a session.
 * Format: "bsky-cli:handle" or "bsky-cli:profile:handle"
 */
export function sessionKey(handle: string, profile?: string): string {
  return profile ? `${profile}:${handle}` : handle;
}

/**
 * Store a session string in the OS keychain.
 * Returns true if stored successfully, false if keychain unavailable.
 */
export async function keychainStore(
  key: string,
  data: string,
): Promise<boolean> {
  try {
    switch (process.platform) {
      case "darwin":
        return await macosStore(key, data);
      case "linux":
        return await linuxStore(key, data);
      case "win32":
        return await windowsStore(key, data);
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * Load a session string from the OS keychain.
 * Returns null if not found or keychain unavailable.
 */
export async function keychainLoad(key: string): Promise<string | null> {
  try {
    switch (process.platform) {
      case "darwin":
        return await macosLoad(key);
      case "linux":
        return await linuxLoad(key);
      case "win32":
        return await windowsLoad(key);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Delete a session from the OS keychain.
 */
export async function keychainDelete(key: string): Promise<void> {
  try {
    switch (process.platform) {
      case "darwin":
        await execFileAsync("security", [
          "delete-generic-password",
          "-s",
          SERVICE,
          "-a",
          key,
        ]);
        break;
      case "linux":
        await execFileAsync("secret-tool", [
          "clear",
          "service",
          SERVICE,
          "account",
          key,
        ]);
        break;
      case "win32":
        await execFileAsync("powershell", [
          "-Command",
          `cmdkey /delete:${SERVICE}:${key}`,
        ]);
        break;
    }
  } catch {
    // Ignore — may not exist
  }
}

// ── macOS: Keychain Access ───────────────────────────────────────────

async function macosStore(key: string, data: string): Promise<boolean> {
  // Delete existing entry first (update not supported atomically)
  await execFileAsync("security", [
    "delete-generic-password",
    "-s",
    SERVICE,
    "-a",
    key,
  ]).catch(() => {});

  await execFileAsync("security", [
    "add-generic-password",
    "-s",
    SERVICE,
    "-a",
    key,
    "-w",
    data,
    "-U",
  ]);
  return true;
}

async function macosLoad(key: string): Promise<string | null> {
  const { stdout } = await execFileAsync("security", [
    "find-generic-password",
    "-s",
    SERVICE,
    "-a",
    key,
    "-w",
  ]);
  return stdout.trim() || null;
}

// ── Linux: libsecret / GNOME Keyring ─────────────────────────────────

async function linuxStore(key: string, data: string): Promise<boolean> {
  await execFileAsync(
    "secret-tool",
    ["store", "--label", `${SERVICE} session`, "service", SERVICE, "account", key],
    { input: data },
  );
  return true;
}

async function linuxLoad(key: string): Promise<string | null> {
  const { stdout } = await execFileAsync("secret-tool", [
    "lookup",
    "service",
    SERVICE,
    "account",
    key,
  ]);
  return stdout.trim() || null;
}

// ── Windows: Credential Manager ──────────────────────────────────────

async function windowsStore(key: string, data: string): Promise<boolean> {
  // Use PowerShell to store credential — cmdkey has length limits
  const target = `${SERVICE}:${key}`;
  const script = `
    $cred = New-Object System.Management.Automation.PSCredential(
      "${key}",
      (ConvertTo-SecureString "${data.replace(/"/g, '`"')}" -AsPlainText -Force)
    )
    cmdkey /generic:${target} /user:${key} /pass:$($cred.GetNetworkCredential().Password)
  `;
  await execFileAsync("powershell", ["-Command", script]);
  return true;
}

async function windowsLoad(key: string): Promise<string | null> {
  const target = `${SERVICE}:${key}`;
  const script = `
    $out = cmdkey /list:${target} 2>&1
    if ($LASTEXITCODE -ne 0) { exit 1 }
    # cmdkey doesn't expose password; use CredentialManager module or fallback
  `;
  // Windows credential retrieval is complex — fall back to filesystem
  // This is a best-effort implementation
  try {
    await execFileAsync("powershell", ["-Command", script]);
    return null; // Fall back to filesystem on Windows
  } catch {
    return null;
  }
}
