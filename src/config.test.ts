import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sessionPath, configPath, authPath, bskyDir } from "./config";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
}));

vi.mock("chalk", () => ({
  default: {
    yellow: (s: string) => s,
    dim: (s: string) => s,
  },
}));

describe("sessionPath", () => {
  it("returns default session path without profile", () => {
    const path = sessionPath();
    expect(path).toMatch(/session\.json$/);
  });

  it("returns profile-specific session path", () => {
    const path = sessionPath("work");
    expect(path).toMatch(/session-work\.json$/);
  });
});

describe("configPath (legacy)", () => {
  it("returns legacy config path for migration", () => {
    const path = configPath();
    expect(path).toMatch(/\.config\/bsky\/config\.json$/);
  });

  it("returns legacy profile-specific path", () => {
    const path = configPath("work");
    expect(path).toMatch(/\.config\/bsky\/config-work\.json$/);
  });
});

describe("authPath (legacy)", () => {
  it("returns legacy auth path for handle", () => {
    const path = authPath("alice.bsky.social");
    expect(path).toMatch(/\.config\/bsky\/alice\.bsky\.social\.auth$/);
  });

  it("returns prefixed legacy auth path", () => {
    const path = authPath("alice.bsky.social", "work-");
    expect(path).toMatch(
      /\.config\/bsky\/work-alice\.bsky\.social\.auth$/,
    );
  });
});

describe("bskyDir", () => {
  const originalEnv = process.env;
  const originalPlatform = process.platform;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    process.env = originalEnv;
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("respects XDG_CONFIG_HOME on any platform", () => {
    process.env.XDG_CONFIG_HOME = "/custom/config";
    expect(bskyDir()).toBe("/custom/config/bsky-cli");
  });

  it("uses Library/Application Support on macOS", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const dir = bskyDir();
    expect(dir).toMatch(/Library\/Application Support\/bsky-cli$/);
  });

  it("uses .config on linux", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const dir = bskyDir();
    expect(dir).toMatch(/\.config\/bsky-cli$/);
  });
});

describe("loadSessionConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("throws when no session file exists and no legacy config", async () => {
    const { readFile, mkdir } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    (mkdir as any).mockResolvedValue(undefined);
    (readFile as any).mockRejectedValue(new Error("ENOENT"));
    (existsSync as any).mockReturnValue(false);

    const { loadSessionConfig } = await import("./config");
    await expect(loadSessionConfig()).rejects.toThrow("No session found");
  });

  it("loads session from file", async () => {
    const session = {
      host: "https://bsky.social",
      bgs: "https://bsky.network",
      handle: "alice.bsky.social",
      did: "did:plc:abc",
      accessJwt: "access",
      refreshJwt: "refresh",
    };
    const { readFile, mkdir } = await import("node:fs/promises");
    (mkdir as any).mockResolvedValue(undefined);
    (readFile as any).mockResolvedValue(JSON.stringify(session));

    const { loadSessionConfig } = await import("./config");
    const cfg = await loadSessionConfig();
    expect(cfg.handle).toBe("alice.bsky.social");
    expect(cfg.did).toBe("did:plc:abc");
    expect((cfg as any).password).toBeUndefined();
  });

  it("env vars override session values", async () => {
    const session = {
      host: "https://bsky.social",
      bgs: "https://bsky.network",
      handle: "alice.bsky.social",
      did: "did:plc:abc",
      accessJwt: "access",
      refreshJwt: "refresh",
    };
    const { readFile, mkdir } = await import("node:fs/promises");
    (mkdir as any).mockResolvedValue(undefined);
    (readFile as any).mockResolvedValue(JSON.stringify(session));

    process.env.BSKY_HOST = "https://custom.pds.social";
    const { loadSessionConfig } = await import("./config");
    const cfg = await loadSessionConfig();
    expect(cfg.host).toBe("https://custom.pds.social");
  });
});

describe("loadSessionConfig — handle-based fallback", () => {
  const originalEnv = process.env;

  const aliceSession = {
    host: "https://bsky.social",
    bgs: "https://bsky.network",
    handle: "alice.bsky.social",
    did: "did:plc:alice",
    accessJwt: "access-alice",
    refreshJwt: "refresh-alice",
  };

  const bobSession = {
    host: "https://bsky.social",
    bgs: "https://bsky.network",
    handle: "bob.bsky.social",
    did: "did:plc:bob",
    accessJwt: "access-bob",
    refreshJwt: "refresh-bob",
  };

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("finds session by handle in default session.json", async () => {
    const { readFile, mkdir } = await import("node:fs/promises");
    const { existsSync, readdirSync } = await import("node:fs");
    (mkdir as any).mockResolvedValue(undefined);

    // First readFile call: exact profile file (session-alice.bsky.social.json) → ENOENT
    // Second readFile call: session.json → alice's session
    (readFile as any)
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockResolvedValueOnce(JSON.stringify(aliceSession));
    (existsSync as any).mockReturnValue(true); // bskyDir exists
    (readdirSync as any).mockReturnValue(["session.json"]);

    const { loadSessionConfig } = await import("./config");
    const cfg = await loadSessionConfig("alice.bsky.social");
    expect(cfg.handle).toBe("alice.bsky.social");
    expect(cfg.did).toBe("did:plc:alice");
  });

  it("finds session by handle in named profile file", async () => {
    const { readFile, mkdir } = await import("node:fs/promises");
    const { existsSync, readdirSync } = await import("node:fs");
    (mkdir as any).mockResolvedValue(undefined);

    // Exact file miss, then scan: session.json has wrong handle, session-work.json matches
    (readFile as any)
      .mockRejectedValueOnce(new Error("ENOENT")) // session-bob.bsky.social.json
      .mockResolvedValueOnce(JSON.stringify(aliceSession)) // session.json (wrong handle)
      .mockResolvedValueOnce(JSON.stringify(bobSession)); // session-work.json
    (existsSync as any).mockReturnValue(true);
    (readdirSync as any).mockReturnValue(["session.json", "session-work.json"]);

    const { loadSessionConfig } = await import("./config");
    const cfg = await loadSessionConfig("bob.bsky.social");
    expect(cfg.handle).toBe("bob.bsky.social");
  });

  it("returns null and falls through when no handle matches", async () => {
    const { readFile, mkdir } = await import("node:fs/promises");
    const { existsSync, readdirSync } = await import("node:fs");
    (mkdir as any).mockResolvedValue(undefined);

    (readFile as any)
      .mockRejectedValueOnce(new Error("ENOENT")) // exact file
      .mockResolvedValueOnce(JSON.stringify(aliceSession)); // session.json (wrong handle)
    (existsSync as any).mockReturnValue(false); // No bskyDir for scan, no legacy
    (readdirSync as any).mockReturnValue([]);

    const { loadSessionConfig } = await import("./config");
    await expect(
      loadSessionConfig("unknown.bsky.social"),
    ).rejects.toThrow("No session found");
  });

  it("does NOT attempt handle fallback for simple profile names", async () => {
    const { readFile, mkdir } = await import("node:fs/promises");
    const { existsSync, readdirSync } = await import("node:fs");

    // Clear any queued mockResolvedValueOnce from prior tests
    (readFile as any).mockReset();
    (mkdir as any).mockResolvedValue(undefined);

    // "work" does not contain a dot → no handle scan
    (readFile as any).mockRejectedValue(new Error("ENOENT"));
    (existsSync as any).mockReturnValue(false);
    (readdirSync as any).mockReturnValue(["session.json"]);

    const { loadSessionConfig } = await import("./config");
    await expect(loadSessionConfig("work")).rejects.toThrow("No session found");
    // readdirSync should NOT have been called for handle scanning
    // (it might be called by listProfiles or other code, but the key point
    // is that it doesn't try to read session.json for handle comparison)
    expect(readFile).toHaveBeenCalledTimes(1); // Only the exact file attempt
  });

  it("matches handles case-insensitively", async () => {
    const { readFile, mkdir } = await import("node:fs/promises");
    const { existsSync, readdirSync } = await import("node:fs");
    (mkdir as any).mockResolvedValue(undefined);

    const mixedCaseSession = { ...aliceSession, handle: "Alice.Bsky.Social" };
    (readFile as any)
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockResolvedValueOnce(JSON.stringify(mixedCaseSession));
    (existsSync as any).mockReturnValue(true);
    (readdirSync as any).mockReturnValue(["session.json"]);

    const { loadSessionConfig } = await import("./config");
    const cfg = await loadSessionConfig("alice.bsky.social");
    expect(cfg.handle).toBe("Alice.Bsky.Social");
  });

  it("skips corrupted session files during scan", async () => {
    const { readFile, mkdir } = await import("node:fs/promises");
    const { existsSync, readdirSync } = await import("node:fs");
    (mkdir as any).mockResolvedValue(undefined);

    (readFile as any)
      .mockRejectedValueOnce(new Error("ENOENT")) // exact file
      .mockResolvedValueOnce("not valid json{{{") // corrupted session.json
      .mockResolvedValueOnce(JSON.stringify(aliceSession)); // session-backup.json
    (existsSync as any).mockReturnValue(true);
    (readdirSync as any).mockReturnValue(["session.json", "session-backup.json"]);

    const { loadSessionConfig } = await import("./config");
    const cfg = await loadSessionConfig("alice.bsky.social");
    expect(cfg.handle).toBe("alice.bsky.social");
  });
});

describe("saveSessionConfig", () => {
  it("writes session as JSON with 0o600 permissions", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    (mkdir as any).mockResolvedValue(undefined);
    (writeFile as any).mockResolvedValue(undefined);

    const { saveSessionConfig } = await import("./config");
    const session = {
      host: "https://bsky.social",
      bgs: "https://bsky.network",
      handle: "alice",
      did: "did:plc:abc",
      accessJwt: "access",
      refreshJwt: "refresh",
    };
    await saveSessionConfig(session);
    expect(writeFile).toHaveBeenCalled();
    const [, content, opts] = (writeFile as any).mock.calls[0];
    expect(opts.mode).toBe(0o600);
    const parsed = JSON.parse(content.trim());
    expect(parsed).toEqual(session);
    expect(parsed.password).toBeUndefined();
  });
});
