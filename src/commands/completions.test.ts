import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { registerCompletions } from "./completions";

function makeProgramWithCommands(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("--json", "Output as JSON");
  // Register a simple test command so completions have something to work with
  program.command("test-cmd").description("A test command").option("-n <count>", "Count");
  registerCompletions(program);
  return program;
}

describe("completions", () => {
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutWriteSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
  });

  it("bash completions contain function and command names", async () => {
    const program = makeProgramWithCommands();
    await program.parseAsync(["completions", "bash"], { from: "user" });

    const output = stdoutWriteSpy.mock.calls.map((c: unknown[]) => c[0]).join("");
    expect(output).toContain("_bsky_completions");
    expect(output).toContain("complete -F");
    expect(output).toContain("test-cmd");

    stdoutWriteSpy.mockRestore();
  });

  it("zsh completions contain function", async () => {
    const program = makeProgramWithCommands();
    await program.parseAsync(["completions", "zsh"], { from: "user" });

    const output = stdoutWriteSpy.mock.calls.map((c: unknown[]) => c[0]).join("");
    expect(output).toContain("#compdef bsky");
    expect(output).toContain("_bsky");
    expect(output).toContain("test-cmd");

    stdoutWriteSpy.mockRestore();
  });

  it("fish completions contain command entries", async () => {
    const program = makeProgramWithCommands();
    await program.parseAsync(["completions", "fish"], { from: "user" });

    const output = stdoutWriteSpy.mock.calls.map((c: unknown[]) => c[0]).join("");
    expect(output).toContain("complete -c bsky");
    expect(output).toContain("test-cmd");

    stdoutWriteSpy.mockRestore();
  });

  it("unknown shell exits with error", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    const program = makeProgramWithCommands();
    await program.parseAsync(["completions", "invalid"], { from: "user" });

    expect(errorSpy).toHaveBeenCalledWith(
      "Unknown shell: invalid. Supported: bash, zsh, fish",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
    exitSpy.mockRestore();
    stdoutWriteSpy.mockRestore();
  });
});
