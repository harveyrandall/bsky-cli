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

import { registerReport, registerModList } from "@/commands/moderation";
import { isJson } from "@/index";

function makeProgram(register: (cmd: Command) => void): Command {
  const program = new Command();
  program.exitOverride();
  program.option("--json", "Output as JSON");
  register(program);
  return program;
}

describe("report command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isJson as any).mockReturnValue(false);

    mockAgent.com.atproto.moderation.createReport.mockResolvedValue({
      data: { id: 1, reasonType: "com.atproto.moderation.defs#reasonSpam" },
    });
  });

  it("resolves handle and creates report", async () => {
    mockAgent.getProfile.mockResolvedValue({
      data: { did: "did:plc:resolved", handle: "spammer.bsky.social" },
    });

    const program = makeProgram(registerReport);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["report", "spammer.bsky.social"], {
      from: "user",
    });

    expect(mockAgent.getProfile).toHaveBeenCalledWith({
      actor: "spammer.bsky.social",
    });
    expect(
      mockAgent.com.atproto.moderation.createReport,
    ).toHaveBeenCalledWith({
      reasonType: "com.atproto.moderation.defs#reasonSpam",
      subject: {
        $type: "com.atproto.admin.defs#repoRef",
        did: "did:plc:resolved",
      },
      reason: undefined,
    });

    consoleSpy.mockRestore();
  });

  it("skips resolution when given a DID directly", async () => {
    const program = makeProgram(registerReport);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["report", "did:plc:direct"], { from: "user" });

    expect(mockAgent.getProfile).not.toHaveBeenCalled();
    expect(
      mockAgent.com.atproto.moderation.createReport,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: {
          $type: "com.atproto.admin.defs#repoRef",
          did: "did:plc:direct",
        },
      }),
    );

    consoleSpy.mockRestore();
  });

  it("passes comment with --comment option", async () => {
    mockAgent.getProfile.mockResolvedValue({
      data: { did: "did:plc:spammer", handle: "spammer.bsky.social" },
    });

    const program = makeProgram(registerReport);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(
      ["report", "spammer.bsky.social", "--comment", "This user is spamming"],
      { from: "user" },
    );

    expect(
      mockAgent.com.atproto.moderation.createReport,
    ).toHaveBeenCalledWith({
      reasonType: "com.atproto.moderation.defs#reasonSpam",
      subject: {
        $type: "com.atproto.admin.defs#repoRef",
        did: "did:plc:spammer",
      },
      reason: "This user is spamming",
    });

    consoleSpy.mockRestore();
  });
});

describe("mod-list command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isJson as any).mockReturnValue(false);

    mockAgent.com.atproto.repo.createRecord.mockResolvedValue({
      data: {
        uri: "at://did:plc:test123/app.bsky.graph.list/newlist",
        cid: "bafyreicid-list",
      },
    });
  });

  it("creates list and adds users", async () => {
    mockAgent.getProfile
      .mockResolvedValueOnce({
        data: { did: "did:plc:user1", handle: "user1.bsky.social" },
      })
      .mockResolvedValueOnce({
        data: { did: "did:plc:user2", handle: "user2.bsky.social" },
      });

    const program = makeProgram(registerModList);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(
      [
        "mod-list",
        "user1.bsky.social",
        "user2.bsky.social",
        "--name",
        "Spam List",
        "--desc",
        "Spammers",
      ],
      { from: "user" },
    );

    // First call: create the list
    expect(
      mockAgent.com.atproto.repo.createRecord,
    ).toHaveBeenCalledTimes(3);

    const listCall =
      mockAgent.com.atproto.repo.createRecord.mock.calls[0][0];
    expect(listCall.collection).toBe("app.bsky.graph.list");
    expect(listCall.record.name).toBe("Spam List");
    expect(listCall.record.description).toBe("Spammers");
    expect(listCall.record.purpose).toBe("app.bsky.graph.defs#modlist");
    expect(listCall.repo).toBe("did:plc:test123");

    // Second call: add user1
    const item1Call =
      mockAgent.com.atproto.repo.createRecord.mock.calls[1][0];
    expect(item1Call.collection).toBe("app.bsky.graph.listitem");
    expect(item1Call.record.subject).toBe("did:plc:user1");
    expect(item1Call.record.list).toBe(
      "at://did:plc:test123/app.bsky.graph.list/newlist",
    );

    // Third call: add user2
    const item2Call =
      mockAgent.com.atproto.repo.createRecord.mock.calls[2][0];
    expect(item2Call.collection).toBe("app.bsky.graph.listitem");
    expect(item2Call.record.subject).toBe("did:plc:user2");
    expect(item2Call.record.list).toBe(
      "at://did:plc:test123/app.bsky.graph.list/newlist",
    );

    consoleSpy.mockRestore();
  });
});
