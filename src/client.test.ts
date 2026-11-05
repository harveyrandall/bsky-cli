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

import type { AtpAgent } from "@atproto/api";
import { createClient, sharedClient } from "./client";
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

describe("sharedClient", () => {
  const signedIn = (hasSession = true) => ({ hasSession, clone: vi.fn(() => "a clone") }) as unknown as AtpAgent;
  it("signs in once per profile, handing out clones", async () => {
    const agent = signedIn();
    const signIn = vi.fn(async () => agent);
    expect(await sharedClient("once", signIn)).toBe("a clone");
    expect(await sharedClient("once", signIn)).toBe("a clone");
    expect(signIn).toHaveBeenCalledOnce();
  });
  it("keeps profiles apart", async () => {
    const signIn = vi.fn(async () => signedIn());
    await sharedClient("one", signIn);
    await sharedClient("two", signIn);
    await sharedClient(undefined, signIn);
    expect(signIn).toHaveBeenCalledTimes(3);
  });
  it("signs in again once the session has gone", async () => {
    const signIn = vi.fn(async () => signedIn(false));
    await sharedClient("gone", signIn);
    await sharedClient("gone", signIn);
    expect(signIn).toHaveBeenCalledTimes(2);
  });
});

describe("createClient when it can't tell", () => {
  beforeEach(() => mockAgent.resumeSession.mockReset());
  it.each([
    [new TypeError("fetch failed"), "Can't reach https://bsky.social: fetch failed"],
    [Object.assign(new Error("Bad Gateway"), { status: 502 }), "Can't reach https://bsky.social: Bad Gateway"],
    [Object.assign(new Error("Rate Limit Exceeded"), { status: 429 }), "Can't reach https://bsky.social: Rate Limit Exceeded"],
    [Object.assign(new Error("Token has expired"), { status: 400 }), "Session expired"],
  ])("reports %s", async (err, message) => {
    mockAgent.resumeSession.mockRejectedValueOnce(err);
    await expect(createClient(session)).rejects.toThrow(message);
  });
});
