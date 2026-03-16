import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAgent = {
  resumeSession: vi.fn(),
  com: {
    atproto: {
      server: {
        refreshSession: vi.fn(),
      },
    },
  },
};

vi.mock("@atproto/api", () => ({
  AtpAgent: vi.fn(function () {
    return mockAgent;
  }),
}));

vi.mock("@/config", () => ({
  saveSessionConfig: vi.fn(),
}));

import { createClient } from "./client";
import { saveSessionConfig } from "@/config";

const session = {
  host: "https://bsky.social",
  bgs: "https://bsky.network",
  handle: "alice.bsky.social",
  did: "did:plc:test",
  accessJwt: "old-access",
  refreshJwt: "old-refresh",
};

describe("createClient", () => {
  beforeEach(() => {
    // mockReset clears history AND implementations (mockRejectedValue, etc.)
    mockAgent.resumeSession.mockReset();
    mockAgent.com.atproto.server.refreshSession.mockReset();
    vi.mocked(saveSessionConfig).mockReset();
  });

  it("resumes session and refreshes tokens", async () => {
    mockAgent.com.atproto.server.refreshSession.mockResolvedValue({
      data: {
        did: "did:plc:test",
        handle: "alice.bsky.social",
        accessJwt: "new-access",
        refreshJwt: "new-refresh",
      },
    });

    const agent = await createClient(session);
    expect(agent).toBe(mockAgent);
    expect(mockAgent.resumeSession).toHaveBeenCalled();
    expect(saveSessionConfig).toHaveBeenCalledWith(
      expect.objectContaining({ accessJwt: "new-access" }),
      undefined,
    );
  });

  it("saves refreshed tokens with profile", async () => {
    mockAgent.com.atproto.server.refreshSession.mockResolvedValue({
      data: {
        did: "did:plc:test",
        handle: "alice.bsky.social",
        accessJwt: "new-access",
        refreshJwt: "new-refresh",
      },
    });

    await createClient(session, "work");
    expect(saveSessionConfig).toHaveBeenCalledWith(
      expect.objectContaining({ accessJwt: "new-access" }),
      "work",
    );
  });

  it("throws session expired when refresh fails", async () => {
    mockAgent.resumeSession.mockRejectedValue(new Error("expired"));

    await expect(createClient(session)).rejects.toThrow(
      "Session expired",
    );
  });

  it("does not call login — no password available", async () => {
    mockAgent.com.atproto.server.refreshSession.mockResolvedValue({
      data: {
        did: "did:plc:test",
        handle: "alice.bsky.social",
        accessJwt: "new-access",
        refreshJwt: "new-refresh",
      },
    });

    await createClient(session);
    // Verify login is not a property — client no longer does password-based auth
    expect((mockAgent as any).login).toBeUndefined();
  });
});
