import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("@/config", () => ({
  authPath: vi.fn(
    (handle: string, prefix: string = "") =>
      `/mock/.config/bsky/${prefix}${handle}.auth`,
  ),
}));

// Need to mock node:fs for createWriteStream
vi.mock("node:fs", () => ({
  createWriteStream: vi.fn(() => ({
    close: vi.fn(),
  })),
}));

describe("readAuth", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns null when auth file missing", async () => {
    const { readFile } = await import("node:fs/promises");
    (readFile as any).mockRejectedValue(new Error("ENOENT"));

    const { readAuth } = await import("./auth");
    const result = await readAuth("alice.bsky.social");
    expect(result).toBeNull();
  });

  it("returns parsed AuthInfo when file exists", async () => {
    const authInfo = {
      did: "did:plc:test",
      handle: "alice.bsky.social",
      accessJwt: "access-token",
      refreshJwt: "refresh-token",
    };
    const { readFile } = await import("node:fs/promises");
    (readFile as any).mockResolvedValue(JSON.stringify(authInfo));

    const { readAuth } = await import("./auth");
    const result = await readAuth("alice.bsky.social");
    expect(result).toEqual(authInfo);
  });
});

describe("writeAuth", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("writes auth data with correct permissions", async () => {
    const { writeFile } = await import("node:fs/promises");
    (writeFile as any).mockResolvedValue(undefined);

    const { writeAuth } = await import("./auth");
    const auth = {
      did: "did:plc:test",
      handle: "alice.bsky.social",
      accessJwt: "access",
      refreshJwt: "refresh",
    };
    await writeAuth(auth, "alice.bsky.social");

    expect(writeFile).toHaveBeenCalled();
    const [filePath, content, opts] = (writeFile as any).mock.calls[0];
    expect(filePath).toBe("/mock/.config/bsky/alice.bsky.social.auth");
    expect(opts.mode).toBe(0o600);
    // Verify it writes valid JSON
    const parsed = JSON.parse(content.trim());
    expect(parsed).toEqual(auth);
  });
});
