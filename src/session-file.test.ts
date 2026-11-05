import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bskyDir, saveSessionConfig, sessionPath } from "@/config";

const session = { host: "https://bsky.social", bgs: "https://bsky.network", handle: "me.test", did: "did:plc:me", accessJwt: "access", refreshJwt: "refresh" };

describe("saving a session", () => {
  let home: string;
  const onDisk = (path = sessionPath()) => JSON.parse(readFileSync(path, "utf-8")) as typeof session;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bsky-session-"));
    vi.stubEnv("XDG_CONFIG_HOME", home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    chmodSync(home, 0o700);
    rmSync(home, { recursive: true, force: true });
  });

  it("is on disk by the time it returns, as a refresh has already spent the old token", () => {
    saveSessionConfig(session);
    expect(onDisk()).toEqual(session);
  });
  it("is for your eyes only, even over a file that wasn't", () => {
    mkdirSync(bskyDir(), { recursive: true });
    writeFileSync(sessionPath(), "{}", { mode: 0o644 });
    saveSessionConfig(session);
    expect(statSync(sessionPath()).mode & 0o777).toBe(0o600);
  });
  it("leaves nothing else behind", () => {
    saveSessionConfig(session, "work");
    expect(readdirSync(bskyDir())).toEqual(["session-work.json"]);
  });
  it("writes through a symlink, rather than replacing it", () => {
    mkdirSync(bskyDir(), { recursive: true });
    const real = join(home, "kept-elsewhere.json");
    writeFileSync(real, "{}");
    symlinkSync(real, sessionPath());
    saveSessionConfig(session);
    expect(lstatSync(sessionPath()).isSymbolicLink()).toBe(true);
    expect(onDisk(real)).toEqual(session);
  });
  it.skipIf(process.getuid?.() === 0)("leaves the old file whole if it can't be written", () => {
    saveSessionConfig(session);
    chmodSync(bskyDir(), 0o500);
    expect(() => saveSessionConfig({ ...session, refreshJwt: "newer" })).toThrow();
    chmodSync(bskyDir(), 0o700);
    expect(onDisk()).toEqual(session);
  });
});
