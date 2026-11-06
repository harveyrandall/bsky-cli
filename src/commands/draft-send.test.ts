import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { getClient } from "@/index";
import { createPost } from "@/commands/post";
import { registerDrafts, syncNetworkDrafts } from "@/commands/draft";
import { bskyDir } from "@/config";
import { listDrafts, loadDraft, saveDraft } from "@/drafts";

vi.mock("@/index", () => ({ getClient: vi.fn(), isJson: vi.fn(() => false) }));
vi.mock("@/commands/post", async (original) => ({
  ...(await original<typeof import("@/commands/post")>()),
  createPost: vi.fn(),
}));
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({ question: async () => "y", close() {} }),
}));

/** Real draft files: only sending and signing in are faked. */
describe("sending a thread draft, on real files", () => {
  let home: string;
  let errors: string[];
  const uri = (n: number) => `at://did:plc:me/app.bsky.feed.post/${n}`;
  const agent = {
    com: {
      atproto: {
        repo: {
          // Post 1 starts the thread, and each one after replies within it
          getRecord: vi.fn(async ({ rkey }: { rkey: string }) => ({
            data: {
              uri: uri(Number(rkey)),
              cid: `cid${rkey}`,
              value: rkey === "1" ? {} : { reply: { root: { uri: uri(1), cid: "cid1" } } },
            },
          })),
        },
      },
    },
  } as unknown as Awaited<ReturnType<typeof getClient>>;

  const thread = (reason: "manual" | "network" = "manual") =>
    saveDraft({ type: "thread", reason, text: "one two three", posts: [{ text: "one" }, { text: "two" }, { text: "three" }] });
  const send = (id: string) => {
    const program = new Command().exitOverride().option("-p, --profile <name>").option("--json");
    registerDrafts(program);
    return program.parseAsync(["drafts", "send", id], { from: "user" });
  };
  /** Every post goes, except those whose text is in `failing`. */
  const sending = (...failing: string[]) => {
    let next = 1;
    vi.mocked(createPost).mockImplementation(async (_agent, text) => {
      if (failing.includes(text)) throw new Error("server said no");
      const n = next++;
      return { uri: uri(n), cid: `cid${n}` };
    });
  };
  const sent = () => vi.mocked(createPost).mock.calls.map(([, text]) => text);
  /** As in a terminal, where the sync asks before sending and is answered yes. */
  const inTerminal = async (run: () => Promise<void>) => {
    const stdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      await run();
    } finally {
      if (stdin) Object.defineProperty(process.stdin, "isTTY", stdin);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  };
  /** Signing in sends offline drafts first, as the real one does. */
  const signingInSyncs = () =>
    vi.mocked(getClient).mockImplementationOnce(async () => {
      await syncNetworkDrafts(agent);
      return agent;
    });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bsky-draft-"));
    vi.stubEnv("XDG_CONFIG_HOME", home);
    vi.mocked(getClient).mockResolvedValue(agent);
    vi.mocked(createPost).mockReset();
    errors = [];
    vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a.join(" ")));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("keeps only what's left when a post fails, replying to the last that went", async () => {
    const { id } = await thread();
    sending("two");
    await expect(send(id)).rejects.toThrow("server said no");

    const left = await loadDraft(id);
    expect(left.posts?.map((p) => p.text)).toEqual(["two", "three"]);
    expect(left.replyUri).toBe(uri(1));
  });

  it("shows the next post as the draft's text, not one that's gone", async () => {
    const { id } = await thread();
    sending("two");
    await expect(send(id)).rejects.toThrow();
    expect((await loadDraft(id)).text).toBe("two");
  });

  it("keeps the thread's root when it carries on from a later post", async () => {
    const { id } = await thread();
    sending("three");
    await expect(send(id)).rejects.toThrow();

    vi.mocked(createPost).mockClear();
    sending();
    await send(id);

    const [, , last] = vi.mocked(createPost).mock.calls[0];
    expect(last?.reply?.uri).toBe(uri(2));
    expect(last?.replyRoot?.uri).toBe(uri(1));
  });

  it("says what went and what's left", async () => {
    const { id } = await thread();
    sending("two");
    await expect(send(id)).rejects.toThrow();
    expect(errors.join("\n")).toContain("Posted 1/3");
    expect(errors.join("\n")).toContain(uri(1));
    expect(errors.join("\n")).toContain(`Draft ${id} now holds the other 2`);
  });

  it("carries on from there when sent again, repeating nothing", async () => {
    const { id } = await thread();
    sending("two");
    await expect(send(id)).rejects.toThrow();

    vi.mocked(createPost).mockClear();
    vi.mocked(createPost).mockImplementation(async (_agent, text) => ({ uri: uri(text === "two" ? 2 : 3), cid: "c" }));
    await send(id);

    expect(sent()).toEqual(["two", "three"]);
    const [, , first] = vi.mocked(createPost).mock.calls[0];
    expect(first?.reply?.uri).toBe(uri(1));
    expect(first?.replyRoot?.uri).toBe(uri(1));
    const [, , second] = vi.mocked(createPost).mock.calls[1];
    expect(second?.reply?.uri).toBe(uri(2));
    expect(second?.replyRoot?.uri).toBe(uri(1));
    expect(await listDrafts()).toEqual([]);
  });

  it("has already updated the draft when the next post goes, so a killed run repeats nothing", async () => {
    const { id } = await thread();
    let onDisk: string[] | undefined;
    vi.mocked(createPost)
      .mockResolvedValueOnce({ uri: uri(1), cid: "c" })
      .mockImplementationOnce(async () => {
        onDisk = (await loadDraft(id)).posts?.map((p) => p.text);
        throw new Error("killed");
      });
    await expect(send(id)).rejects.toThrow();
    expect(onDisk).toEqual(["two", "three"]);
  });

  it("changes nothing when the first post fails", async () => {
    const { id } = await thread();
    sending("one");
    await expect(send(id)).rejects.toThrow("server said no");
    expect((await loadDraft(id)).posts).toHaveLength(3);
    expect((await loadDraft(id)).replyUri).toBeUndefined();
    expect(errors.join("\n")).not.toContain("Posted");
  });

  it("warns that a post lost to the network may have gone", async () => {
    const { id } = await thread();
    vi.mocked(createPost)
      .mockResolvedValueOnce({ uri: uri(1), cid: "c" })
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(send(id)).rejects.toThrow();
    expect(errors.join("\n")).toContain("may already have gone");
  });

  /** Something in the temp file's place: the update fails while deleting still works, as on a full disk. */
  const blockUpdates = (id: string) => mkdirSync(join(bskyDir(), "drafts", `${id}.json.${process.pid}.tmp`));

  it("stops if the draft can't be updated, listing what went", async () => {
    const { id } = await thread();
    blockUpdates(id);
    sending();
    await expect(send(id)).rejects.toThrow(`Couldn't update draft ${id}, so sending it again would repeat the last post above`);
    expect(sent()).toEqual(["one"]);
    expect(errors.join("\n")).toContain("Posted 1/3");
    expect(errors.join("\n")).toContain(uri(1));
  });

  it("finishes a thread when only the last update would fail, as that needs none", async () => {
    const { id } = await saveDraft({ type: "thread", reason: "manual", text: "one", posts: [{ text: "one" }] });
    blockUpdates(id);
    sending();
    await send(id);
    expect(await listDrafts()).toEqual([]);
  });

  it("does the same when offline drafts are sent", () =>
    inTerminal(async () => {
      const { id } = await thread("network");
      sending("two");
      await syncNetworkDrafts(agent);
      expect((await loadDraft(id)).posts?.map((p) => p.text)).toEqual(["two", "three"]);
      expect((await loadDraft(id)).replyUri).toBe(uri(1));

      vi.mocked(createPost).mockClear();
      sending();
      await syncNetworkDrafts(agent);
      expect(sent()).toEqual(["two", "three"]);
      expect(await listDrafts()).toEqual([]);
    }));

  it("doesn't send a draft again that signing in has just sent", () =>
    inTerminal(async () => {
      const { id } = await thread("network");
      sending();
      signingInSyncs();
      await send(id);
      expect(sent()).toEqual(["one", "two", "three"]);
      expect(await listDrafts()).toEqual([]);
      expect(errors.join("\n")).toContain(`Draft ${id} has already gone`);
    }));

  it("carries on from what signing in got through", () =>
    inTerminal(async () => {
      const { id } = await thread("network");
      vi.mocked(createPost)
        .mockResolvedValueOnce({ uri: uri(1), cid: "c" })
        .mockRejectedValueOnce(new Error("server said no"))
        .mockResolvedValue({ uri: uri(2), cid: "c" });
      signingInSyncs();
      await send(id);
      expect(sent()).toEqual(["one", "two", "two", "three"]);
      expect(await listDrafts()).toEqual([]);
    }));
});
