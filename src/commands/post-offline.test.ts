import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { getClient } from "@/index";
import { registerPost } from "@/commands/post";
import { syncNetworkDrafts } from "@/commands/draft";
import { listDrafts, saveDraft } from "@/drafts";
import { createMockAgent } from "@/test-utils";

vi.mock("@/index", () => ({ getClient: vi.fn(), isJson: vi.fn(() => false) }));
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({ question: async () => "y", close() {} }),
}));

/** Real draft files: only the server and signing in are faked. */
describe("trying a post again after it was saved offline", () => {
  let home: string;
  let errors: string[];
  const agent = createMockAgent();
  const client = agent as unknown as Awaited<ReturnType<typeof getClient>>;

  const offline = () => vi.mocked(getClient).mockRejectedValueOnce(new TypeError("fetch failed"));
  const online = () => vi.mocked(getClient).mockResolvedValueOnce(client);
  /** Signing in in a terminal, with yes to sending offline drafts. */
  const onlineAndSyncing = () =>
    vi.mocked(getClient).mockImplementationOnce(async () => {
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      try {
        await syncNetworkDrafts(client);
      } finally {
        Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
      }
      return client;
    });
  const post = (...text: string[]) => {
    const program = new Command().exitOverride().option("-p, --profile <name>");
    registerPost(program);
    return program.parseAsync(["post", ...text], { from: "user" });
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bsky-offline-"));
    vi.stubEnv("XDG_CONFIG_HOME", home);
    agent.post.mockReset();
    agent.post.mockResolvedValue({ uri: "at://did:plc:me/app.bsky.feed.post/1", cid: "c" });
    errors = [];
    vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a.join(" ")));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("keeps one draft however many times it's tried offline", async () => {
    offline();
    await expect(post("hello")).rejects.toThrow("exit 1");
    offline();
    await expect(post("hello")).rejects.toThrow("exit 1");

    const drafts = await listDrafts();
    expect(drafts).toHaveLength(1);
    expect(errors.filter((e) => e.includes(`Post saved as draft: ${drafts[0].id}`))).toHaveLength(2);
  });

  it("keeps different posts apart", async () => {
    offline();
    await expect(post("hello")).rejects.toThrow("exit 1");
    offline();
    await expect(post("goodbye")).rejects.toThrow("exit 1");
    expect(await listDrafts()).toHaveLength(2);
  });

  it("doesn't post it again when signing in has just sent it", async () => {
    offline();
    await expect(post("hello")).rejects.toThrow("exit 1");

    onlineAndSyncing();
    await expect(post("hello")).rejects.toThrow("exit 0");

    expect(agent.post).toHaveBeenCalledTimes(1);
    expect(await listDrafts()).toEqual([]);
    expect(errors.join("\n")).toContain("has just gone");
  });

  it("sends it and drops the draft if signing in didn't, so it can't go twice", async () => {
    offline();
    await expect(post("hello")).rejects.toThrow("exit 1");

    online();
    await post("hello");

    expect(agent.post).toHaveBeenCalledTimes(1);
    expect(await listDrafts()).toEqual([]);
  });

  it("leaves a draft alone that was saved on purpose", async () => {
    await saveDraft({ type: "post", reason: "manual", text: "hello" });
    online();
    await post("hello");
    expect(await listDrafts()).toHaveLength(1);
  });
});
