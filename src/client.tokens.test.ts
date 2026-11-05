import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, sharedClient } from "@/client";
import { loadSessionConfig, saveSessionConfig, sessionPath } from "@/config";
import type { SessionConfig } from "@/lib/types";

const HOST = "https://pds.test.invalid";
const DID = "did:plc:testtesttesttesttesttest";
const MINUTES = 60_000;

/**
 * A server, as far as tokens go, and the real AtpAgent talks to it. The rules are
 * @atproto/pds's as remembered, as no real server is reachable from a test: access
 * tokens last two hours, and a spent refresh token keeps working for two more.
 */
function fakeServer() {
  let now = 0;
  let issued = 0;
  const spent = new Map<string, number>();
  const refreshTokens = new Set<string>();
  const accessTokens = new Map<string, number>();
  const counts = { refreshSession: 0 };
  const issue = () => {
    const [accessJwt, refreshJwt] = [`access-${++issued}`, `refresh-${issued}`];
    accessTokens.set(accessJwt, now + 120 * MINUTES);
    refreshTokens.add(refreshJwt);
    return { accessJwt, refreshJwt, did: DID, handle: "me.test", active: true, emailConfirmed: true, didDoc: { id: DID } };
  };
  const json = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const token = request.headers.get("authorization")?.replace("Bearer ", "") ?? "";
    if (new URL(request.url).pathname.endsWith("refreshSession")) {
      counts.refreshSession++;
      const dead = !refreshTokens.has(token) || (spent.has(token) && spent.get(token)! + 120 * MINUTES <= now);
      if (dead) return json(400, { error: "ExpiredToken", message: "Token has been revoked" });
      if (!spent.has(token)) spent.set(token, now);
      return json(200, issue());
    }
    if ((accessTokens.get(token) ?? 0) <= now) return json(400, { error: "ExpiredToken", message: "Token has expired" });
    return json(200, { feed: [] });
  };
  return { fetchStub, issue, counts, at: (minutes: number) => (now = minutes * MINUTES) };
}

describe("a session's tokens", () => {
  let home: string;
  let server: ReturnType<typeof fakeServer>;
  const onDisk = (profile?: string) => JSON.parse(readFileSync(sessionPath(profile), "utf-8")) as SessionConfig;
  const loggedIn = (profile?: string) => {
    const { accessJwt, refreshJwt, did, handle } = server.issue();
    const session = { host: HOST, bgs: "", did, handle, accessJwt, refreshJwt };
    saveSessionConfig(session, profile);
    return session;
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bsky-tokens-"));
    vi.stubEnv("XDG_CONFIG_HOME", home);
    server = fakeServer();
    vi.stubGlobal("fetch", server.fetchStub);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("are refreshed once per sign-in, as each refresh spends one", async () => {
    await createClient(loggedIn());
    expect(server.counts.refreshSession).toBe(1);
  });
  it("are on disk as soon as you're signed in, the same ones the agent holds", async () => {
    const agent = await createClient(loggedIn());
    expect(onDisk().refreshJwt).toBe(agent.session?.refreshJwt);
    expect(onDisk().accessJwt).toBe(agent.session?.accessJwt);
  });
  it("keep the rest of what's in the file", async () => {
    await createClient({ ...loggedIn(), bgs: "https://bgs.test.invalid" });
    expect(onDisk()).toMatchObject({ host: HOST, bgs: "https://bgs.test.invalid", handle: "me.test", did: DID });
  });
  it("go to the profile's own file", async () => {
    await createClient(loggedIn("work"), "work");
    expect(onDisk("work").refreshJwt).toBe("refresh-2");
  });
  it.each([["work"], [undefined]])("go back to the file a handle found them in: %s", async (profile) => {
    loggedIn(profile);
    const dim = vi.spyOn(console, "error").mockImplementation(() => {}); // "Using session for…"
    await createClient(await loadSessionConfig("me.test"), "me.test");
    dim.mockRestore();
    expect(onDisk(profile).refreshJwt).toBe("refresh-2");
    expect(existsSync(sessionPath("me.test"))).toBe(false);
  });
  it("reach the file when one runs out while you're signed in", async () => {
    const agent = await createClient(loggedIn());
    server.at(150);
    await agent.getTimeline();
    expect(server.counts.refreshSession).toBe(2);
    expect(onDisk().refreshJwt).toBe(agent.session?.refreshJwt);
  });
  it("reach the file through a clone, which is what everyone is given", async () => {
    const session = loggedIn("clone");
    const clone = await sharedClient("clone", () => createClient(session, "clone"));
    server.at(150);
    await clone.getTimeline();
    expect(onDisk("clone").refreshJwt).toBe(clone.session?.refreshJwt);
  });
  it("leave a file the next run can use, however long this one ran", async () => {
    const agent = await createClient(loggedIn());
    for (const minutes of [150, 300, 450]) {
      server.at(minutes);
      await agent.getTimeline();
    }
    server.at(700);
    await expect(createClient(onDisk())).resolves.toBeDefined();
  });
  describe("with something newer in the file", () => {
    const signedIn = async () => {
      const agent = await createClient(loggedIn());
      server.at(150);
      return agent;
    };
    it("leave another account's login alone, and say so", async () => {
      const agent = await signedIn();
      saveSessionConfig({ ...onDisk(), did: "did:plc:someoneelse", handle: "bob.test", refreshJwt: "bobs" });
      const warn = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(agent.getTimeline()).resolves.toBeDefined();
      expect(warn.mock.calls.flat().join()).toContain("Another account has logged in to this profile");
      expect(onDisk()).toMatchObject({ handle: "bob.test", refreshJwt: "bobs" });
    });
    it("replace the same account's, as a command in another terminal leaves", async () => {
      const agent = await signedIn();
      saveSessionConfig({ ...onDisk(), refreshJwt: "from-another-terminal" });
      await agent.getTimeline();
      expect(onDisk().refreshJwt).toBe(agent.session?.refreshJwt);
    });
    it("replace a file that can't be read", async () => {
      const agent = await signedIn();
      writeFileSync(sessionPath(), "{ cut sho");
      await agent.getTimeline();
      expect(onDisk().refreshJwt).toBe(agent.session?.refreshJwt);
    });
    it("come back if the file has gone", async () => {
      const agent = await signedIn();
      rmSync(sessionPath());
      await agent.getTimeline();
      expect(onDisk().refreshJwt).toBe(agent.session?.refreshJwt);
    });
  });
  it("still work if they can't be saved, and you're told", async () => {
    const session = loggedIn();
    rmSync(sessionPath());
    mkdirSync(sessionPath()); // a folder in the way, which nothing can write over
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const agent = await createClient(session);
    expect(warn.mock.calls.flat().join()).toContain("Couldn't save your session");
    warn.mockRestore();
    await expect(agent.getTimeline()).resolves.toBeDefined();
    expect(agent.session?.refreshJwt).toBe("refresh-2"); // not put back to the one it spent
  });
  it("stay as they were if the server refuses them", async () => {
    const session = { ...loggedIn(), refreshJwt: "nonsense" };
    await expect(createClient(session)).rejects.toThrow("Session expired");
    expect(onDisk().refreshJwt).toBe("refresh-1");
  });
  it.each([
    ["a proxy", 403, { error: "Forbidden", message: "Blocked by a proxy" }],
    ["a takedown", 400, { error: "AccountTakedown", message: "Account has been taken down" }],
  ])("aren't called expired over %s, which says nothing about them", async (_, status, body) => {
    const session = loggedIn();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    await expect(createClient(session)).rejects.toThrow(`Couldn't sign in at ${HOST}: ${body.message}`);
  });
  it("aren't called expired over a failure this runtime words its own way", async () => {
    const session = loggedIn();
    vi.stubGlobal("fetch", async () => {
      throw new Error("Was there a typo in the url or port?"); // Bun's, which release binaries are built with
    });
    await expect(createClient(session)).rejects.toThrow(`Couldn't sign in at ${HOST}: Was there a typo`);
  });
  it("stay as they were if the server can't be reached, even if the file has moved on", async () => {
    const session = loggedIn();
    saveSessionConfig({ ...session, refreshJwt: "from-another-terminal" });
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(createClient(session)).rejects.toThrow("Can't reach");
    expect(onDisk().refreshJwt).toBe("from-another-terminal");
  });
});
