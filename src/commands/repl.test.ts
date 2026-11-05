import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerRepl, replAgent } from "@/commands/repl";
import { applyConfigToProgram } from "@/toml-config";
import { DEFAULT_MARKERS } from "@/repl/core/markers";

const { startRepl, smokeFrame, pickSession, sessionsHome } = vi.hoisted(() => ({
  startRepl: vi.fn(),
  smokeFrame: vi.fn(() => "FRAME"),
  pickSession: vi.fn(),
  sessionsHome: { dir: "/nonexistent-bsky-home" },
}));
vi.mock("@/repl", () => ({ startRepl, smokeFrame, pickSession }));
vi.mock("@/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config")>()),
  bskyDir: () => sessionsHome.dir,
}));
vi.mock("@/index", () => ({
  getClient: vi.fn(async () => ({ session: { did: "did:plc:me", handle: "me.bsky.social" } })),
}));
vi.mock("@/commands/post", () => ({ createPost: vi.fn() }));
vi.mock("@/commands/like", () => ({ likePost: vi.fn(), unlikePost: vi.fn() }));
vi.mock("@/commands/repost", () => ({ repostPost: vi.fn(), unrepostPost: vi.fn() }));

const original = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
function setTTY(stdin: boolean | undefined, stdout: boolean | undefined) {
  Object.defineProperty(process.stdin, "isTTY", { value: stdin, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: stdout, configurable: true });
}
function makeProgram(config: Record<string, unknown> = {}) {
  const program = new Command().exitOverride();
  registerRepl(program);
  applyConfigToProgram(program, config);
  return program;
}
const replOpts = (p: Command) => p.commands.find((c) => c.name() === "repl")!.opts();

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.BSKY_REPL_SMOKE;
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  setTTY(original.stdin, original.stdout);
  delete process.env.BSKY_REPL_SMOKE;
});

describe("bsky repl", () => {
  it("starts the REPL with default markers in a terminal", async () => {
    setTTY(true, true);
    await makeProgram().parseAsync(["repl"], { from: "user" });
    expect(startRepl).toHaveBeenCalledWith(expect.objectContaining({ markers: DEFAULT_MARKERS, handle: "me.bsky.social" }));
  });

  it("treats a mistyped command as unknown, with a suggestion, instead of opening the REPL", async () => {
    setTTY(true, true);
    const errors: string[] = [];
    const p = makeProgram().configureOutput({ writeErr: (text) => void errors.push(text) });
    await expect(p.parseAsync(["rpel"], { from: "user" })).rejects.toMatchObject({ code: "commander.unknownCommand" });
    expect(errors.join("")).toContain("unknown command 'rpel'");
    expect(errors.join("")).toContain("Did you mean repl");
    expect(startRepl).not.toHaveBeenCalled();
  });

  it("refuses arguments after repl itself", async () => {
    setTTY(true, true);
    await expect(makeProgram().parseAsync(["repl", "extra"], { from: "user" })).rejects.toMatchObject({
      code: "commander.unknownCommand",
    });
    expect(startRepl).not.toHaveBeenCalled();
  });

  it.each([[false, true], [true, false]])(
    "prints help to stderr and exits 1 when stdin.isTTY=%s, stdout.isTTY=%s",
    async (stdin, stdout) => {
      setTTY(stdin, stdout);
      await expect(makeProgram().parseAsync(["repl"], { from: "user" })).rejects.toMatchObject({ exitCode: 1 });
      expect(process.stderr.write).toHaveBeenCalledWith(
        "bsky repl needs an interactive terminal: stdin and stdout must both be terminals.\n",
      );
      expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("Interactive composer for posts"));
      expect(startRepl).not.toHaveBeenCalled();
    },
  );

  it("smoke mode renders one frame even without a TTY", async () => {
    setTTY(false, false);
    process.env.BSKY_REPL_SMOKE = "1";
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await makeProgram().parseAsync(["repl"], { from: "user" });
    expect(out).toHaveBeenCalledWith("FRAME\n");
    expect(startRepl).not.toHaveBeenCalled();
  });

  it("smoke mode still checks the [repl] config", async () => {
    setTTY(false, false);
    process.env.BSKY_REPL_SMOKE = "1";
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(
      makeProgram({ repl: { "cut-marker": "" } }).parseAsync(["repl"], { from: "user" }),
    ).rejects.toThrow('Invalid [repl] cut-marker = ""');
    expect(out).not.toHaveBeenCalledWith("FRAME\n");
  });

  it("rejects --undo values other than 0, 5, 10 or 15", async () => {
    await expect(makeProgram().parseAsync(["repl", "--undo", "7"], { from: "user" })).rejects.toThrow(
      "must be 0, 5, 10 or 15",
    );
  });

  it("parses every flag", async () => {
    process.env.BSKY_REPL_SMOKE = "1";
    const p = makeProgram();
    await p.parseAsync(
      ["repl", "-t", "-l", "--undo", "5", "--pace", "0", "-f", "--thread-label", "-r", "k3f9xq", "-R"],
      { from: "user" },
    );
    expect(replOpts(p)).toMatchObject({
      autoThread: true, prefixThread: true, undo: 5, pace: 0, forceAlt: true,
      threadLabel: true, resume: "k3f9xq", resumable: false,
    });
  });

  it("takes [repl] config values, and CLI flags win", async () => {
    setTTY(true, true);
    const p = makeProgram({ repl: { undo: 5, pace: 10, "split-marker": "~~" } });
    await p.parseAsync(["repl", "--pace", "15"], { from: "user" });
    expect(replOpts(p)).toMatchObject({ undo: 5, pace: 15 });
    expect(startRepl).toHaveBeenCalledWith(expect.objectContaining({ markers: { ...DEFAULT_MARKERS, split: "~~" } }));
  });

  it.each([
    [{ undo: 7 }, "Invalid [repl] undo = 7: must be 0, 5, 10 or 15"],
    [{ pace: "soon" }, 'Invalid [repl] pace = "soon": must be 0, 5, 10 or 15'],
  ])("stops with an error for config %o", async (repl, message) => {
    setTTY(true, true);
    await expect(makeProgram({ repl }).parseAsync(["repl"], { from: "user" })).rejects.toThrow(message);
    expect(startRepl).not.toHaveBeenCalled();
  });

  it("opens for a bare `bsky` in a terminal", async () => {
    setTTY(true, true);
    await makeProgram().parseAsync([], { from: "user" });
    expect(startRepl).toHaveBeenCalled();
  });

  it("prints the program's help for a bare `bsky` without a terminal, as before", async () => {
    setTTY(false, false);
    await expect(makeProgram().parseAsync([], { from: "user" })).rejects.toMatchObject({ exitCode: 1 });
    expect(process.stderr.write).not.toHaveBeenCalledWith(expect.stringContaining("needs an interactive terminal"));
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("Commands:"));
  });

  it.each([
    ["-f", ["repl", "-f"], {}],
    ["force-alt = true", ["repl"], { repl: { "force-alt": true } }],
  ])("requires alt text with %s, and doesn't call it unused", async (_, args, config) => {
    setTTY(true, true);
    await makeProgram(config).parseAsync(args, { from: "user" });
    expect(startRepl).toHaveBeenCalledWith(expect.objectContaining({ settings: expect.objectContaining({ forceAlt: true }) }));
    expect(process.stderr.write).not.toHaveBeenCalledWith(expect.stringContaining("force-alt"));
  });

  it("maps flags and config onto the session's settings", async () => {
    setTTY(true, true);
    const p = makeProgram({ repl: { "ask-to-save": false } });
    await p.parseAsync(["repl", "-t", "-l", "--undo", "5", "--pace", "10", "--prepend-thread-label"], { from: "user" });
    expect(startRepl).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: {
          autoThread: true,
          prefixThread: true,
          threadLabel: "prepend",
          undo: 5,
          pace: 10,
          askToSave: false,
          verbose: false,
          forceAlt: false,
        },
      }),
    );
  });

  it("leaves undo and pace unset so the REPL asks", async () => {
    setTTY(true, true);
    await makeProgram().parseAsync(["repl", "--thread-label"], { from: "user" });
    expect(startRepl).toHaveBeenCalledWith(
      expect.objectContaining({ settings: expect.objectContaining({ undo: undefined, pace: undefined, threadLabel: "append" }) }),
    );
  });

  it("stops with an error for a bad marker", async () => {
    setTTY(true, true);
    await expect(
      makeProgram({ repl: { "cut-marker": "" } }).parseAsync(["repl"], { from: "user" }),
    ).rejects.toThrow('Invalid [repl] cut-marker = ""');
  });
});

describe("saved sessions", () => {
  const uri = "at://did:plc:me/app.bsky.feed.post/3lbx7kt5def2a";
  const file = (o: object = {}) => ({
    version: 1,
    id: "k3f7xq",
    createdAt: "2026-11-04T09:00:00.000Z",
    updatedAt: "2026-11-04T10:00:00.000Z",
    handle: "me.bsky.social",
    did: "did:plc:me",
    settings: {
      autoThread: true, prefixThread: false, threadLabel: false, undo: 5, pace: 0, verbose: false, forceAlt: false, askToSave: true,
      markers: { split: "~~", send: "//>", cut: "<//" },
    },
    posts: [{ label: "1", uri, cid: "bafyabc", rkey: "3lbx7kt5def2a", authorDid: "did:plc:me", root: { uri, cid: "bafyabc" }, excerpt: "hi" }],
    viewed: [],
    mode: { kind: "idle" },
    composer: { text: "", cursor: 0 },
    staged: [],
    pending: [],
    history: [],
    counters: { nextLabel: 2, nextViewed: 0, nextLetter: 0 },
    ...o,
  });
  const sessions = () => join(sessionsHome.dir, "repl", "sessions");
  const write = (o: object = {}) => {
    mkdirSync(sessions(), { recursive: true });
    const f = file(o) as { id: string };
    writeFileSync(join(sessions(), `${f.id}.json`), JSON.stringify(f));
  };
  const session = () => startRepl.mock.lastCall?.[0].session;
  beforeEach(() => {
    sessionsHome.dir = mkdtempSync(join(tmpdir(), "bsky-repl-"));
    setTTY(true, true);
    pickSession.mockResolvedValue(undefined);
  });
  afterEach(() => rmSync(sessionsHome.dir, { recursive: true, force: true }));

  it("starts a new session without asking when none are saved", async () => {
    await makeProgram().parseAsync(["repl"], { from: "user" });
    expect(pickSession).not.toHaveBeenCalled();
    expect(session()).toMatchObject({ keep: 50, did: "did:plc:me" });
    expect(session().id).toMatch(/^[a-z2-7]{6}$/);
    expect(session().resume).toBeUndefined();
  });
  it("offers saved sessions, and + new starts a new one", async () => {
    write();
    await makeProgram().parseAsync(["repl"], { from: "user" });
    expect(pickSession).toHaveBeenCalledOnce();
    expect(session().resume).toBeUndefined();
    expect(session().id).not.toBe("k3f7xq");
  });
  it("opens the session picked, with its settings and markers", async () => {
    write();
    pickSession.mockResolvedValue("k3f7xq");
    await makeProgram().parseAsync(["repl"], { from: "user" });
    expect(session()).toMatchObject({ id: "k3f7xq", createdAt: "2026-11-04T09:00:00.000Z", resume: { id: "k3f7xq" } });
    expect(startRepl.mock.lastCall?.[0]).toMatchObject({ settings: { autoThread: true, undo: 5 }, markers: { split: "~~" } });
    expect(existsSync(join(sessions(), "k3f7xq.lock"))).toBe(true);
  });
  it("stops if you quit the list", async () => {
    write();
    pickSession.mockResolvedValue(null);
    await makeProgram().parseAsync(["repl"], { from: "user" });
    expect(startRepl).not.toHaveBeenCalled();
  });
  it.each([["last"], ["k3f"], ["k3f7xq"]])("skips the list with -r %s", async (id) => {
    write();
    await makeProgram().parseAsync(["repl", "-r", id], { from: "user" });
    expect(pickSession).not.toHaveBeenCalled();
    expect(session().resume).toMatchObject({ id: "k3f7xq" });
  });
  it("shows the list for a bare -r", async () => {
    write();
    await makeProgram().parseAsync(["repl", "-r"], { from: "user" });
    expect(pickSession).toHaveBeenCalledOnce();
  });
  it("says when -r finds nothing", async () => {
    await expect(makeProgram().parseAsync(["repl", "-r", "last"], { from: "user" })).rejects.toThrow("No saved sessions");
    await expect(makeProgram().parseAsync(["repl", "-r", "zz"], { from: "user" })).rejects.toThrow('No saved session "zz"');
  });
  it("won't open a session another REPL has", async () => {
    write();
    mkdirSync(sessions(), { recursive: true });
    writeFileSync(join(sessions(), "k3f7xq.lock"), String(process.pid));
    await expect(makeProgram().parseAsync(["repl", "-r", "k3f7xq"], { from: "user" })).rejects.toThrow("Session k3f7xq is open in another REPL");
    expect(startRepl).not.toHaveBeenCalled();
  });
  it("says which session it can't open, and lets go of it", async () => {
    write({ did: "nope" });
    await expect(makeProgram().parseAsync(["repl", "-r", "k3f7xq"], { from: "user" })).rejects.toThrow("Can't open session k3f7xq: Session file: bad did");
    expect(existsSync(join(sessions(), "k3f7xq.lock"))).toBe(false);
  });
  it("says how to clear a lock it can't take", async () => {
    write();
    writeFileSync(join(sessions(), "k3f7xq.lock"), String(process.pid));
    await expect(makeProgram().parseAsync(["repl", "-r", "k3f7xq"], { from: "user" })).rejects.toThrow(join(sessions(), "k3f7xq.lock"));
  });
  it("switches to another profile's login, and back if it can't", async () => {
    const { getClient } = await import("@/index");
    const p = makeProgram();
    await p.parseAsync(["repl"], { from: "user" });
    const { switchAccount } = startRepl.mock.lastCall![0];
    vi.mocked(getClient).mockResolvedValueOnce({ session: { did: "did:plc:work", handle: "work.bsky.social" } } as never);
    await expect(switchAccount("work")).resolves.toMatchObject({ handle: "work.bsky.social", agent: { selfDid: "did:plc:work" } });
    expect(p.opts().profile).toBe("work");
    vi.mocked(getClient).mockRejectedValueOnce(new Error("Not logged in"));
    await expect(switchAccount("nope")).rejects.toThrow("Not logged in");
    expect(p.opts().profile).toBe("work");
  });
  it("uses the session's own profile", async () => {
    write({ profile: "work" });
    const p = makeProgram();
    await p.parseAsync(["repl", "-r", "last"], { from: "user" });
    expect(p.opts().profile).toBe("work");
    expect(startRepl.mock.lastCall?.[0].profile).toBe("work");
  });
  it("refuses a session from another account, and lets go of it", async () => {
    write({ did: "did:plc:someoneelse", handle: "other.bsky.social" });
    await expect(makeProgram().parseAsync(["repl", "-r", "last"], { from: "user" })).rejects.toThrow("@other.bsky.social");
    expect(startRepl).not.toHaveBeenCalled();
    expect(existsSync(join(sessions(), "k3f7xq.lock"))).toBe(false);
  });
  it("neither offers nor saves with -R, or resumable = false", async () => {
    write();
    await makeProgram().parseAsync(["repl", "-R"], { from: "user" });
    expect(pickSession).not.toHaveBeenCalled();
    expect(session()).toBeUndefined();
    await makeProgram({ repl: { resumable: false } }).parseAsync(["repl"], { from: "user" });
    expect(pickSession).not.toHaveBeenCalled();
    expect(session()).toBeUndefined();
  });
  it("keeps saving a session resumed with -R, or what you answered would be asked again", async () => {
    write();
    await makeProgram().parseAsync(["repl", "-R", "-r", "last"], { from: "user" });
    expect(session()).toMatchObject({ id: "k3f7xq", resume: { id: "k3f7xq" } });
  });
  it("reads keep-sessions from the config, and checks it", async () => {
    await makeProgram({ repl: { "keep-sessions": 5 } }).parseAsync(["repl"], { from: "user" });
    expect(session().keep).toBe(5);
    await expect(makeProgram({ repl: { "keep-sessions": "lots" } }).parseAsync(["repl"], { from: "user" })).rejects.toThrow(
      'Invalid [repl] keep-sessions = "lots"',
    );
    await expect(makeProgram({ repl: { "keep-sessions": 0 } }).parseAsync(["repl"], { from: "user" })).rejects.toThrow("Invalid [repl] keep-sessions = 0");
  });
  it("checks keep-sessions in the smoke run too", async () => {
    process.env.BSKY_REPL_SMOKE = "1";
    await expect(makeProgram({ repl: { "keep-sessions": 0 } }).parseAsync(["repl"], { from: "user" })).rejects.toThrow("keep-sessions");
  });
  it("lets go of the session if its profile can't log in", async () => {
    write({ profile: "work" });
    const { getClient } = await import("@/index");
    vi.mocked(getClient).mockRejectedValueOnce(new Error("Not logged in"));
    await expect(makeProgram().parseAsync(["repl", "-r", "last"], { from: "user" })).rejects.toThrow("Not logged in");
    expect(existsSync(join(sessions(), "k3f7xq.lock"))).toBe(false);
  });
});

describe("replAgent", () => {
  const uri = "at://did:plc:alice/app.bsky.feed.post/3lbx7kt5def2x";
  const lookup = (record: unknown) => {
    const post = { uri, cid: "bafyabc", author: { did: "did:plc:alice", handle: "alice.bsky.social" }, record };
    const agent = { session: { did: "did:plc:me" }, getPosts: vi.fn(async () => ({ data: { posts: [post] } })) };
    return replAgent(agent as never).getPosts([uri as never]);
  };
  it("drops a post whose reply refs can't be trusted, rather than calling it a thread root", async () => {
    await expect(lookup({ text: "hi", reply: { root: { uri: "nonsense", cid: "x" }, parent: { uri, cid: "bafyabc" } } })).resolves.toEqual([]);
  });
  it("hands createPost the parent and root the right way round", async () => {
    const { createPost } = await import("@/commands/post");
    vi.mocked(createPost).mockResolvedValueOnce({ uri, cid: "bafyabc" } as never);
    const agent = { session: { did: "did:plc:me" } } as never;
    const parent = { uri: `${uri}p`, cid: "bafyp" } as never;
    const root = { uri: `${uri}r`, cid: "bafyr" } as never;
    await expect(replAgent(agent).post("hi", { parent, root })).resolves.toEqual({ uri, cid: "bafyabc" });
    expect(createPost).toHaveBeenCalledWith(agent, "hi", { reply: parent, replyRoot: root });
  });
  it("deletes a post", async () => {
    const deletePost = vi.fn(async () => {});
    await replAgent({ session: { did: "did:plc:me" }, deletePost } as never).deletePost(uri as never);
    expect(deletePost).toHaveBeenCalledWith(uri);
  });
  it("passes likes and reposts on to what the CLI uses", async () => {
    const { likePost, unlikePost } = await import("@/commands/like");
    const { repostPost, unrepostPost } = await import("@/commands/repost");
    vi.mocked(unlikePost).mockResolvedValueOnce(true);
    const agent = { session: { did: "did:plc:me" } } as never;
    const post = { uri, cid: "bafyabc" } as never;
    const client = replAgent(agent);
    await client.like(post);
    await client.repost(post);
    await expect(client.unlike(post)).resolves.toBe(true);
    await client.unrepost(post);
    expect(likePost).toHaveBeenCalledWith(agent, post);
    expect(repostPost).toHaveBeenCalledWith(agent, post);
    expect(unlikePost).toHaveBeenCalledWith(agent, uri);
    expect(unrepostPost).toHaveBeenCalledWith(agent, uri);
  });
  it("won't start without a session", () => {
    expect(() => replAgent({} as never)).toThrow("Not logged in");
  });
  it("hands createPost staged media", async () => {
    const { createPost } = await import("@/commands/post");
    vi.mocked(createPost).mockResolvedValueOnce({ uri, cid: "bafyabc" } as never);
    const agent = { session: { did: "did:plc:me" } } as never;
    await replAgent(agent).post("hi", undefined, [{ path: "/x/a.png", kind: "image", alt: "A chart" }]);
    expect(createPost).toHaveBeenCalledWith(agent, "hi", { images: ["/x/a.png"], imageAlts: ["A chart"] });
  });
  it("hands createPost the post being quoted", async () => {
    const { createPost } = await import("@/commands/post");
    vi.mocked(createPost).mockResolvedValueOnce({ uri, cid: "bafyabc" } as never);
    const agent = { session: { did: "did:plc:me" } } as never;
    const quoted = { uri, cid: "bafyq" } as never;
    await replAgent(agent).post("look", undefined, undefined, quoted);
    expect(vi.mocked(createPost).mock.lastCall?.[2].quote).toEqual({ uri, cid: "bafyq" });
  });
  it("keeps a post with no reply as its own root", async () => {
    await expect(lookup({ text: "hi" })).resolves.toMatchObject([{ uri, text: "hi", root: undefined }]);
  });
});
