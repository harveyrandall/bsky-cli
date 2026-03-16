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
