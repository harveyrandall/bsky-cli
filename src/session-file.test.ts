import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { authPath, bskyDir, configPath, loadSessionConfig, saveSessionConfig, sessionPath } from "@/config";

// homedir() is what finds the old folder, and the real one holds a config these tests would rename.
const fake = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (original) => ({ ...(await original<typeof import("node:os")>()), homedir: () => fake.home }));

const session = { host: "https://bsky.social", bgs: "https://bsky.network", handle: "me.test", did: "did:plc:me", accessJwt: "access", refreshJwt: "refresh" };

describe("saving a session", () => {
  let home: string;
  const onDisk = (path = sessionPath()) => JSON.parse(readFileSync(path, "utf-8")) as typeof session;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bsky-session-"));
    fake.home = home;
    vi.stubEnv("XDG_CONFIG_HOME", home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
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
    try {
      expect(() => saveSessionConfig({ ...session, refreshJwt: "newer" })).toThrow();
    } finally {
      chmodSync(bskyDir(), 0o700);
    }
    expect(onDisk()).toEqual(session);
  });
  it("is for your eyes only from the start", () => {
    saveSessionConfig(session);
    expect(statSync(sessionPath()).mode & 0o777).toBe(0o600);
  });
  it("swaps the file rather than writing into it, so nobody can read half of one", () => {
    saveSessionConfig(session);
    const before = statSync(sessionPath()).ino;
    saveSessionConfig({ ...session, refreshJwt: "newer" });
    expect(statSync(sessionPath()).ino).not.toBe(before);
  });

  describe("from the old folder", () => {
    const legacy = () => {
      // Stop here rather than touch the real folder, whatever changes around this test.
      expect(configPath().startsWith(home)).toBe(true);
      mkdirSync(dirname(configPath()), { recursive: true });
      writeFileSync(configPath(), JSON.stringify({ handle: "me.test", host: session.host, bgs: session.bgs }));
      writeFileSync(authPath("me.test"), JSON.stringify({ handle: "me.test", did: session.did, accessJwt: "access", refreshJwt: "refresh" }));
    };
    it("moves it to the new one, keeping the old as a backup", async () => {
      legacy();
      vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(loadSessionConfig()).resolves.toMatchObject({ refreshJwt: "refresh" });
      expect(onDisk()).toMatchObject({ refreshJwt: "refresh", did: session.did });
      expect(existsSync(`${configPath()}.bak`)).toBe(true);
    });
    it.skipIf(process.getuid?.() === 0)("says why, if it can't", async () => {
      legacy();
      mkdirSync(bskyDir(), { recursive: true });
      chmodSync(bskyDir(), 0o500);
      const warn = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(loadSessionConfig()).rejects.toThrow("No session found");
      } finally {
        chmodSync(bskyDir(), 0o700);
      }
      expect(warn.mock.calls.flat().join()).toContain("Couldn't move your session to");
      expect(existsSync(configPath())).toBe(true);
    });
  });
});
