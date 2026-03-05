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

import { registerInviteCodes } from "./invite";
import { isJson } from "@/index";
import { outputJson } from "@/lib/format";

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerInviteCodes(program);
  return program;
}

describe("invite-codes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isJson as any).mockReturnValue(false);
  });

  it("lists available codes", async () => {
    const codes = [
      { code: "invite-abc", uses: [], available: 1 },
      { code: "invite-def", uses: [{ usedBy: "someone" }], available: 1 },
    ];

    mockAgent.com.atproto.server.getAccountInviteCodes.mockResolvedValue({
      data: { codes },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = makeProgram();
    await program.parseAsync(["invite-codes"], { from: "user" });

    expect(
      mockAgent.com.atproto.server.getAccountInviteCodes,
    ).toHaveBeenCalledWith({ includeUsed: false });

    // First code: 0 uses < 1 available => plain
    expect(logSpy).toHaveBeenCalledWith("invite-abc");
    // Second code: 1 use >= 1 available => magentaBright with "(used)"
    // chalk.magentaBright wraps the string, so check that the call arg contains the code
    const secondCall = logSpy.mock.calls[1][0] as string;
    expect(secondCall).toContain("invite-def");
    expect(secondCall).toContain("(used)");

    logSpy.mockRestore();
  });

  it("includes used codes when --used is passed", async () => {
    mockAgent.com.atproto.server.getAccountInviteCodes.mockResolvedValue({
      data: { codes: [] },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = makeProgram();
    await program.parseAsync(["invite-codes", "--used"], { from: "user" });

    expect(
      mockAgent.com.atproto.server.getAccountInviteCodes,
    ).toHaveBeenCalledWith({ includeUsed: true });

    logSpy.mockRestore();
  });

  it("outputs JSON when json mode is enabled", async () => {
    (isJson as any).mockReturnValue(true);

    const code1 = { code: "invite-abc", uses: [], available: 1 };
    const code2 = { code: "invite-def", uses: [], available: 1 };

    mockAgent.com.atproto.server.getAccountInviteCodes.mockResolvedValue({
      data: { codes: [code1, code2] },
    });

    const program = makeProgram();
    await program.parseAsync(["invite-codes"], { from: "user" });

    expect(outputJson).toHaveBeenCalledTimes(2);
    expect(outputJson).toHaveBeenCalledWith(code1);
    expect(outputJson).toHaveBeenCalledWith(code2);
  });
});
