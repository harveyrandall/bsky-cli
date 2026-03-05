import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { createMockAgent } from "@/test-utils";

const mockAgent = createMockAgent();

vi.mock("@/index", () => ({
  getClient: vi.fn(() => Promise.resolve(mockAgent)),
  isJson: vi.fn(() => false),
}));

vi.mock("@/lib/format", () => ({
  outputJson: vi.fn(),
}));

import { registerAppPassword } from "./password";
import { isJson } from "@/index";
import { outputJson } from "@/lib/format";

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerAppPassword(program);
  return program;
}

describe("app-password list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isJson as any).mockReturnValue(false);
  });

  it("shows app passwords", async () => {
    mockAgent.com.atproto.server.listAppPasswords.mockResolvedValue({
      data: {
        passwords: [
          { name: "cli-app", createdAt: "2024-01-01T00:00:00Z" },
          { name: "web-app", createdAt: "2024-02-01T00:00:00Z" },
        ],
      },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = makeProgram();
    await program.parseAsync(["app-password", "list"], { from: "user" });

    expect(logSpy).toHaveBeenCalledWith("cli-app (2024-01-01T00:00:00Z)");
    expect(logSpy).toHaveBeenCalledWith("web-app (2024-02-01T00:00:00Z)");
    logSpy.mockRestore();
  });

  it("outputs JSON when json mode is enabled", async () => {
    (isJson as any).mockReturnValue(true);

    const pw1 = { name: "cli-app", createdAt: "2024-01-01T00:00:00Z" };
    const pw2 = { name: "web-app", createdAt: "2024-02-01T00:00:00Z" };

    mockAgent.com.atproto.server.listAppPasswords.mockResolvedValue({
      data: { passwords: [pw1, pw2] },
    });

    const program = makeProgram();
    await program.parseAsync(["app-password", "list"], { from: "user" });

    expect(outputJson).toHaveBeenCalledTimes(2);
    expect(outputJson).toHaveBeenCalledWith(pw1);
    expect(outputJson).toHaveBeenCalledWith(pw2);
  });
});

describe("app-password add", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isJson as any).mockReturnValue(false);
  });

  it("creates an app password", async () => {
    mockAgent.com.atproto.server.createAppPassword.mockResolvedValue({
      data: { name: "test-app", password: "xxxx-yyyy-zzzz" },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = makeProgram();
    await program.parseAsync(["app-password", "add", "test-app"], {
      from: "user",
    });

    expect(
      mockAgent.com.atproto.server.createAppPassword,
    ).toHaveBeenCalledWith({ name: "test-app" });
    expect(logSpy).toHaveBeenCalledWith("test-app: xxxx-yyyy-zzzz");
    logSpy.mockRestore();
  });
});

describe("app-password revoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("revokes an app password", async () => {
    mockAgent.com.atproto.server.revokeAppPassword.mockResolvedValue({});

    const program = makeProgram();
    await program.parseAsync(["app-password", "revoke", "test-app"], {
      from: "user",
    });

    expect(
      mockAgent.com.atproto.server.revokeAppPassword,
    ).toHaveBeenCalledWith({ name: "test-app" });
  });
});
