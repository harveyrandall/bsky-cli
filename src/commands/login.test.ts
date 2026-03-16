import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

const mockLogin = vi.fn();

vi.mock("@atproto/api", () => ({
  AtpAgent: vi.fn(function (opts: { service: string }) {
    return {
      service: opts.service,
      login: mockLogin,
    };
  }),
}));

vi.mock("@/config", () => ({
  saveSessionConfig: vi.fn(),
}));

vi.mock("@/auth", () => ({
  promptPassword: vi.fn(() => Promise.resolve("prompted-pass")),
  prompt2FA: vi.fn(),
}));

vi.mock("@/lib/credential-store", () => ({
  keychainStore: vi.fn().mockResolvedValue(true),
  sessionKey: vi.fn((handle: string, profile?: string) =>
    profile ? `${profile}:${handle}` : handle,
  ),
}));

vi.mock("chalk", () => ({
  default: { green: (s: string) => s },
}));

import { registerLogin } from "./login";
import { saveSessionConfig } from "@/config";
import { promptPassword } from "@/auth";

const loginResponse = {
  data: {
    handle: "alice.bsky.social",
    did: "did:plc:test123",
    accessJwt: "access-token",
    refreshJwt: "refresh-token",
  },
};

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("-p, --profile <name>", "Profile name");
  registerLogin(program);
  return program;
}

describe("login", () => {
  const originalEnv = process.env.BSKY_PASSWORD;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogin.mockResolvedValue(loginResponse);
    delete process.env.BSKY_PASSWORD;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.BSKY_PASSWORD = originalEnv;
    } else {
      delete process.env.BSKY_PASSWORD;
    }
  });

  it("authenticates and saves session (no password stored)", async () => {
    const program = makeProgram();
    await program.parseAsync(["login", "alice.bsky.social", "mypassword"], {
      from: "user",
    });

    // Verify login was called with correct credentials
    expect(mockLogin).toHaveBeenCalledWith({
      identifier: "alice.bsky.social",
      password: "mypassword",
    });

    // Verify session saved WITHOUT password
    expect(saveSessionConfig).toHaveBeenCalledWith(
      {
        host: "https://bsky.social",
        bgs: "https://bsky.network",
        handle: "alice.bsky.social",
        did: "did:plc:test123",
        accessJwt: "access-token",
        refreshJwt: "refresh-token",
      },
      undefined,
    );
  });

  it("uses env BSKY_PASSWORD when no password argument", async () => {
    process.env.BSKY_PASSWORD = "env-pass";

    const program = makeProgram();
    await program.parseAsync(["login", "alice.bsky.social"], {
      from: "user",
    });

    expect(mockLogin).toHaveBeenCalledWith({
      identifier: "alice.bsky.social",
      password: "env-pass",
    });
    // Session saved — no password field
    expect(saveSessionConfig).toHaveBeenCalledWith(
      expect.not.objectContaining({ password: expect.anything() }),
      undefined,
    );
  });

  it("prompts for password as last fallback", async () => {
    delete process.env.BSKY_PASSWORD;

    const program = makeProgram();
    await program.parseAsync(["login", "alice.bsky.social"], {
      from: "user",
    });

    expect(promptPassword).toHaveBeenCalled();
    expect(mockLogin).toHaveBeenCalledWith({
      identifier: "alice.bsky.social",
      password: "prompted-pass",
    });
  });

  it("saves session with custom host and bgs", async () => {
    const program = makeProgram();
    await program.parseAsync(
      [
        "login",
        "alice.bsky.social",
        "mypassword",
        "--host",
        "https://custom.pds.example",
        "--bgs",
        "https://custom.bgs.example",
      ],
      { from: "user" },
    );

    expect(saveSessionConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "https://custom.pds.example",
        bgs: "https://custom.bgs.example",
      }),
      undefined,
    );
  });
});
