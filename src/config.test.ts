import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { configPath, authPath } from "./config";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
}));

describe("configPath", () => {
  it("returns default path without profile", () => {
    const path = configPath();
    expect(path).toMatch(/\.config\/bsky\/config\.json$/);
  });

  it("returns profile-specific path", () => {
    const path = configPath("work");
    expect(path).toMatch(/\.config\/bsky\/config-work\.json$/);
  });
});

describe("authPath", () => {
  it("returns auth path for handle", () => {
    const path = authPath("alice.bsky.social");
    expect(path).toMatch(/\.config\/bsky\/alice\.bsky\.social\.auth$/);
  });

  it("returns prefixed auth path", () => {
    const path = authPath("alice.bsky.social", "work-");
    expect(path).toMatch(/\.config\/bsky\/work-alice\.bsky\.social\.auth$/);
  });
});

describe("loadConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("throws when no credentials available", async () => {
    const { readFile, mkdir } = await import("node:fs/promises");
    (mkdir as any).mockResolvedValue(undefined);
    (readFile as any).mockRejectedValue(new Error("ENOENT"));

    const { loadConfig } = await import("./config");
    await expect(loadConfig()).rejects.toThrow("No credentials found");
  });

  it("loads config from file", async () => {
    const { readFile, mkdir } = await import("node:fs/promises");
    (mkdir as any).mockResolvedValue(undefined);
    (readFile as any).mockResolvedValue(
      JSON.stringify({ host: "https://bsky.social", bgs: "https://bsky.network", handle: "alice.bsky.social", password: "secret" })
    );

    const { loadConfig } = await import("./config");
    const cfg = await loadConfig();
    expect(cfg.handle).toBe("alice.bsky.social");
    expect(cfg.password).toBe("secret");
  });

  it("env vars override file values", async () => {
    const { readFile, mkdir } = await import("node:fs/promises");
    (mkdir as any).mockResolvedValue(undefined);
    (readFile as any).mockResolvedValue(
      JSON.stringify({ host: "https://bsky.social", bgs: "https://bsky.network", handle: "alice.bsky.social", password: "file-pw" })
    );

    process.env.BSKY_PASSWORD = "env-pw";
    const { loadConfig } = await import("./config");
    const cfg = await loadConfig();
    expect(cfg.password).toBe("env-pw");
  });
});

describe("saveConfig", () => {
  it("writes config as JSON", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    (mkdir as any).mockResolvedValue(undefined);
    (writeFile as any).mockResolvedValue(undefined);

    const { saveConfig } = await import("./config");
    await saveConfig({ host: "https://bsky.social", bgs: "https://bsky.network", handle: "alice", password: "pw" });
    expect(writeFile).toHaveBeenCalled();
    const written = (writeFile as any).mock.calls[0][1];
    expect(JSON.parse(written.trim())).toEqual({ host: "https://bsky.social", bgs: "https://bsky.network", handle: "alice", password: "pw" });
  });
});
