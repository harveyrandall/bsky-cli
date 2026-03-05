import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

vi.mock("@/config", () => ({
  saveConfig: vi.fn(),
}));

vi.mock("@/auth", () => ({
  promptPassword: vi.fn(() => Promise.resolve("prompted-pass")),
}));

import { registerLogin } from "./login";
import { saveConfig } from "@/config";
import { promptPassword } from "@/auth";

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
    delete process.env.BSKY_PASSWORD;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.BSKY_PASSWORD = originalEnv;
    } else {
      delete process.env.BSKY_PASSWORD;
    }
  });

  it("saves config with handle and password", async () => {
    const program = makeProgram();
    await program.parseAsync(["login", "alice.bsky.social", "mypassword"], {
      from: "user",
    });

    expect(saveConfig).toHaveBeenCalledWith(
      {
        host: "https://bsky.social",
        bgs: "https://bsky.network",
        handle: "alice.bsky.social",
        password: "mypassword",
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

    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ password: "env-pass" }),
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
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ password: "prompted-pass" }),
      undefined,
    );
  });

  it("saves config with custom host and bgs", async () => {
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

    expect(saveConfig).toHaveBeenCalledWith(
      {
        host: "https://custom.pds.example",
        bgs: "https://custom.bgs.example",
        handle: "alice.bsky.social",
        password: "mypassword",
      },
      undefined,
    );
  });
});
