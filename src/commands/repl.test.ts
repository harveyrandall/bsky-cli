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
    expect(startRepl).toHaveBeenCalledWith({ markers: DEFAULT_MARKERS });
  });

  it.each([[false, true], [true, false]])(
    "prints help to stderr and exits 1 when stdin.isTTY=%s, stdout.isTTY=%s",
    async (stdin, stdout) => {
      setTTY(stdin, stdout);
      await expect(makeProgram().parseAsync(["repl"], { from: "user" })).rejects.toMatchObject({ exitCode: 1 });
      expect(process.stderr.write).toHaveBeenCalled();
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
    expect(startRepl).toHaveBeenCalledWith({ markers: { ...DEFAULT_MARKERS, split: "~~" } });
  });

  it("stops with an error for a bad marker", async () => {
    setTTY(true, true);
    await expect(
      makeProgram({ repl: { "cut-marker": "" } }).parseAsync(["repl"], { from: "user" }),
    ).rejects.toThrow('Invalid [repl] cut-marker = ""');
  });
});
