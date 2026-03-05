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

import {
  registerProfile,
  registerProfileUpdate,
  registerSession,
} from "@/commands/profile";
import { isJson } from "@/index";
import { outputJson } from "@/lib/format";

function makeProgram(register: (cmd: Command) => void): Command {
  const program = new Command();
  program.exitOverride();
  program.option("--json", "Output as JSON");
  register(program);
  return program;
}

describe("profile command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isJson as any).mockReturnValue(false);
  });

  it("displays profile info", async () => {
    mockAgent.getProfile.mockResolvedValue({
      data: {
        did: "did:plc:test123",
        handle: "test.bsky.social",
        displayName: "Test User",
        description: "A test user",
        followsCount: 10,
        followersCount: 20,
        avatar: "https://example.com/avatar.jpg",
        banner: "https://example.com/banner.jpg",
      },
    });

    const program = makeProgram(registerProfile);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["profile"], { from: "user" });

    expect(consoleSpy).toHaveBeenCalledWith("Did: did:plc:test123");
    expect(consoleSpy).toHaveBeenCalledWith("Handle: test.bsky.social");
    expect(consoleSpy).toHaveBeenCalledWith("DisplayName: Test User");
    expect(consoleSpy).toHaveBeenCalledWith("Description: A test user");
    expect(consoleSpy).toHaveBeenCalledWith("Follows: 10");
    expect(consoleSpy).toHaveBeenCalledWith("Followers: 20");
    expect(consoleSpy).toHaveBeenCalledWith(
      "Avatar: https://example.com/avatar.jpg",
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      "Banner: https://example.com/banner.jpg",
    );

    consoleSpy.mockRestore();
  });

  it("uses session handle when no --handle provided", async () => {
    mockAgent.getProfile.mockResolvedValue({
      data: {
        did: "did:plc:test123",
        handle: "test.bsky.social",
      },
    });

    const program = makeProgram(registerProfile);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["profile"], { from: "user" });

    expect(mockAgent.getProfile).toHaveBeenCalledWith({
      actor: "test.bsky.social",
    });

    consoleSpy.mockRestore();
  });

  it("uses specified handle with --handle option", async () => {
    mockAgent.getProfile.mockResolvedValue({
      data: {
        did: "did:plc:other456",
        handle: "other.bsky.social",
      },
    });

    const program = makeProgram(registerProfile);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["profile", "--handle", "other.bsky.social"], {
      from: "user",
    });

    expect(mockAgent.getProfile).toHaveBeenCalledWith({
      actor: "other.bsky.social",
    });

    consoleSpy.mockRestore();
  });

  it("outputs JSON in JSON mode", async () => {
    (isJson as any).mockReturnValue(true);

    const profileData = {
      did: "did:plc:test123",
      handle: "test.bsky.social",
      displayName: "Test User",
    };

    mockAgent.getProfile.mockResolvedValue({ data: profileData });

    const program = makeProgram(registerProfile);

    await program.parseAsync(["profile"], { from: "user" });

    expect(outputJson).toHaveBeenCalledWith(profileData);
  });
});

describe("session command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isJson as any).mockReturnValue(false);
  });

  it("displays session info", async () => {
    mockAgent.com.atproto.server.getSession.mockResolvedValue({
      data: {
        did: "did:plc:test123",
        email: "test@example.com",
        handle: "test.bsky.social",
      },
    });

    const program = makeProgram(registerSession);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["session"], { from: "user" });

    expect(consoleSpy).toHaveBeenCalledWith("Did: did:plc:test123");
    expect(consoleSpy).toHaveBeenCalledWith("Email: test@example.com");
    expect(consoleSpy).toHaveBeenCalledWith("Handle: test.bsky.social");

    consoleSpy.mockRestore();
  });
});
