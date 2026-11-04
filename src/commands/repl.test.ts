import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerRepl } from "@/commands/repl";
import { applyConfigToProgram } from "@/toml-config";
import { DEFAULT_MARKERS } from "@/repl/core/markers";

const { startRepl, smokeFrame } = vi.hoisted(() => ({
  startRepl: vi.fn(),
  smokeFrame: vi.fn(() => "FRAME"),
}));
vi.mock("@/repl", () => ({ startRepl, smokeFrame }));
vi.mock("@/index", () => ({
  getClient: vi.fn(async () => ({ session: { did: "did:plc:me", handle: "me.bsky.social" } })),
}));
vi.mock("@/commands/post", () => ({ createPost: vi.fn() }));

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
      expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("Interactive REPL for writing threads"));
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
    setTTY(true, true);
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

  it("says which flags aren't used yet", async () => {
    setTTY(true, true);
    await makeProgram().parseAsync(["repl", "--undo", "5", "-R"], { from: "user" });
    expect(process.stderr.write).toHaveBeenCalledWith(
      "bsky repl: --no-resumable isn't used yet; it takes effect in a later release.\n",
    );
    expect(process.stderr.write).not.toHaveBeenCalledWith(expect.stringContaining("--undo"));
    expect(startRepl).toHaveBeenCalled();
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
