import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAgent = { resumeSession: vi.fn() };
let persistSession: (event: string, data?: object) => void;

vi.mock("@atproto/api", () => ({
  AtpAgent: vi.fn(function (options: { persistSession: typeof persistSession }) {
    persistSession = options.persistSession;
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
  const refreshed = { did: "did:plc:test", handle: "alice.bsky.social", accessJwt: "new-access", refreshJwt: "new-refresh" };

  beforeEach(() => {
    // mockReset clears history AND implementations (mockRejectedValue, etc.)
    mockAgent.resumeSession.mockReset();
    mockAgent.resumeSession.mockImplementation(async () => persistSession("update", refreshed));
    vi.mocked(saveSessionConfig).mockReset();
  });

  it("resumes the saved session, once, with its own tokens", async () => {
    const agent = await createClient(session);
    expect(agent).toBe(mockAgent);
    expect(mockAgent.resumeSession).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ accessJwt: "old-access", refreshJwt: "old-refresh" }),
    );
  });

  it("saves refreshed tokens", async () => {
    await createClient(session);
    expect(saveSessionConfig).toHaveBeenCalledWith(expect.objectContaining({ accessJwt: "new-access", host: session.host }), undefined);
  });

  it("saves refreshed tokens with profile", async () => {
    await createClient(session, "work");
    expect(saveSessionConfig).toHaveBeenCalledWith(expect.objectContaining({ accessJwt: "new-access" }), "work");
  });

  it.each(["expired", "network-error", "create-failed"])("saves nothing on %s", async (event) => {
    mockAgent.resumeSession.mockImplementation(async () => persistSession(event));
    await createClient(session);
    expect(saveSessionConfig).not.toHaveBeenCalled();
  });

  it("throws session expired when refresh fails", async () => {
    mockAgent.resumeSession.mockRejectedValue(new Error("expired"));

    await expect(createClient(session)).rejects.toThrow(
      "Session expired",
    );
  });

  it("does not call login — no password available", async () => {
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
