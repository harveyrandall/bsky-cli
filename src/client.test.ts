import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAgent = {
  resumeSession: vi.fn(),
  login: vi.fn(),
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

vi.mock("@/auth", () => ({
  readAuth: vi.fn(),
  writeAuth: vi.fn(),
  prompt2FA: vi.fn(),
}));

import { createClient } from "./client";
import { readAuth, writeAuth, prompt2FA } from "@/auth";

const config = {
  host: "https://bsky.social",
  bgs: "https://bsky.network",
  handle: "alice.bsky.social",
  password: "secret",
};

describe("createClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resumes session when auth exists and refresh succeeds", async () => {
    (readAuth as any).mockResolvedValue({
      did: "did:plc:test",
      handle: "alice.bsky.social",
      accessJwt: "old-access",
      refreshJwt: "old-refresh",
    });
    mockAgent.com.atproto.server.refreshSession.mockResolvedValue({
      data: {
        did: "did:plc:test",
        handle: "alice.bsky.social",
        accessJwt: "new-access",
        refreshJwt: "new-refresh",
      },
    });

    const agent = await createClient(config);
    expect(agent).toBe(mockAgent);
    expect(mockAgent.resumeSession).toHaveBeenCalled();
    expect(writeAuth).toHaveBeenCalledWith(
      expect.objectContaining({ accessJwt: "new-access" }),
      "alice.bsky.social",
      "",
    );
    expect(mockAgent.login).not.toHaveBeenCalled();
  });

  it("falls back to login when no auth file", async () => {
    (readAuth as any).mockResolvedValue(null);
    mockAgent.login.mockResolvedValue({
      data: {
        did: "did:plc:test",
        handle: "alice.bsky.social",
        accessJwt: "access",
        refreshJwt: "refresh",
      },
    });

    await createClient(config);
    expect(mockAgent.login).toHaveBeenCalledWith({
      identifier: "alice.bsky.social",
      password: "secret",
    });
    expect(writeAuth).toHaveBeenCalled();
  });

  it("falls back to login when refresh fails", async () => {
    (readAuth as any).mockResolvedValue({
      did: "did:plc:test",
      handle: "alice.bsky.social",
      accessJwt: "old",
      refreshJwt: "old",
    });
    mockAgent.resumeSession.mockRejectedValue(new Error("expired"));
    mockAgent.login.mockResolvedValue({
      data: {
        did: "did:plc:test",
        handle: "alice.bsky.social",
        accessJwt: "new-access",
        refreshJwt: "new-refresh",
      },
    });

    await createClient(config);
    expect(mockAgent.login).toHaveBeenCalled();
  });

  it("handles 2FA flow", async () => {
    (readAuth as any).mockResolvedValue(null);
    mockAgent.login
      .mockRejectedValueOnce(new Error("AuthFactorTokenRequired"))
      .mockResolvedValueOnce({
        data: {
          did: "did:plc:test",
          handle: "alice.bsky.social",
          accessJwt: "2fa-access",
          refreshJwt: "2fa-refresh",
        },
      });
    (prompt2FA as any).mockResolvedValue("123456");

    await createClient(config);
    expect(prompt2FA).toHaveBeenCalled();
    expect(mockAgent.login).toHaveBeenCalledTimes(2);
    expect(mockAgent.login).toHaveBeenLastCalledWith({
      identifier: "alice.bsky.social",
      password: "secret",
      authFactorToken: "123456",
    });
  });

  it("throws on non-2FA login failure", async () => {
    (readAuth as any).mockResolvedValue(null);
    mockAgent.login.mockRejectedValue(new Error("InvalidPassword"));

    await expect(createClient(config)).rejects.toThrow("Cannot create session");
  });
});
