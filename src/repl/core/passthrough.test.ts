import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { BLOCKED, passthroughFlags, passthroughNames, runPassthrough } from "./passthrough";

function program() {
  const p = new Command().option("-p, --profile <name>").option("--json");
  p.command("hello")
    .option("--loud")
    .action((opts: { loud?: boolean }) => {
      console.log(`hello ${opts.loud ? "LOUD" : "quiet"}`);
      process.stdout.write("in ");
      process.stdout.write("parts\nand a tail");
      console.error("to stderr");
    });
  p.command("bye").action(() => process.exit(3));
  p.command("boom").action(async () => {
    throw new Error("it broke");
  });
  p.command("who").action(() => console.log(p.opts().profile ?? "default"));
  p.command("format").action(() => console.log(p.opts().json ? "json" : "text"));
  p.command("failing").action(() => {
    process.exitCode = 1;
  });
  p.command("slow").action(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    console.log("done");
  });
  p.command("hidden", { hidden: true }).action(() => {});
  p.command("login").action(() => console.log("should not run"));
  const schedule = p.command("schedule");
  schedule.command("post").action(() => console.log("should not run"));
  schedule.command("list").action(() => console.log("listed"));
  return p;
}

function setup() {
  const lines: string[] = [];
  const io = { print: (text: string) => void lines.push(text) };
  return { lines, io, p: program() };
}

describe("runPassthrough", () => {
  it("delivers what a command prints, line by line, however it was written", async () => {
    const { lines, io, p } = setup();
    await runPassthrough(p, ["hello"], io);
    expect(lines).toEqual(["hello quiet", "in parts", "and a tailto stderr"]);
  });
  it("survives a command that exits, and puts process.exit back", async () => {
    const { lines, io, p } = setup();
    const exit = process.exit;
    await runPassthrough(p, ["bye"], io);
    expect(process.exit).toBe(exit);
    expect(lines).toEqual([]);
  });
  it("reports a command that throws, and puts everything back", async () => {
    const { lines, io, p } = setup();
    const { write } = process.stdout;
    const { log } = console;
    await runPassthrough(p, ["boom"], io);
    expect(lines).toEqual(["it broke"]);
    expect(process.stdout.write).toBe(write);
    expect(console.log).toBe(log);
  });
  it("reports a mistake in the command's own arguments", async () => {
    const { lines, io, p } = setup();
    await runPassthrough(p, ["hello", "--nope"], io);
    expect(lines.join("\n")).toContain("unknown option '--nope'");
  });
  it("doesn't keep options between runs", async () => {
    const { lines, io, p } = setup();
    await runPassthrough(p, ["hello", "--loud"], io);
    await runPassthrough(p, ["hello"], io);
    expect(lines.filter((l) => l.startsWith("hello"))).toEqual(["hello LOUD", "hello quiet"]);
    lines.length = 0;
    await runPassthrough(p, ["--json", "format"], io);
    await runPassthrough(p, ["format"], io);
    expect(lines).toEqual(["json", "text"]);
  });
  it("runs as the REPL's profile", async () => {
    const { lines, io, p } = setup();
    await runPassthrough(p, ["who"], { ...io, profile: "work" });
    await runPassthrough(p, ["who"], io);
    expect(lines).toEqual(["work", "default"]);
  });
  it("leaves the exit code alone", async () => {
    const { io, p } = setup();
    const code = process.exitCode;
    await runPassthrough(p, ["failing"], io);
    expect(process.exitCode).toBe(code);
  });
  it("doesn't capture what else is writing meanwhile, such as Ink drawing its frame", async () => {
    const { lines, io, p } = setup();
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const spied = process.stdout.write;
    const frame = setTimeout(() => process.stdout.write("a frame"), 5);
    await runPassthrough(p, ["slow"], io);
    clearTimeout(frame);
    expect(lines).toEqual(["done"]);
    expect(write).toHaveBeenCalledWith("a frame");
    expect(process.stdout.write).toBe(spied);
    write.mockRestore();
  });
  it.each([
    ["login", ["login"]],
    ["schedule post", ["schedule", "post"]],
  ])("won't run %s, which needs the terminal", async (name, argv) => {
    const { lines, io, p } = setup();
    await runPassthrough(p, argv, io);
    expect(lines).toEqual([`bsky ${name} can't run inside the REPL: ${BLOCKED.get(name)}`]);
  });
  it("runs the safe half of a command group", async () => {
    const { lines, io, p } = setup();
    await runPassthrough(p, ["schedule", "list"], io);
    expect(lines).toEqual(["listed"]);
  });
  it("sees through an option before the command", async () => {
    const { lines, io, p } = setup();
    await runPassthrough(p, ["-p", "work", "login"], io);
    expect(lines[0]).toContain("bsky login can't run inside the REPL");
  });
  it("sees through an alias", async () => {
    const { lines, io, p } = setup();
    p.commands.find((c) => c.name() === "login")!.alias("signin");
    await runPassthrough(p, ["signin"], io);
    expect(lines[0]).toContain("bsky login can't run inside the REPL");
  });
  it("won't fall through to the default command, which is the REPL itself", async () => {
    const { lines, io, p } = setup();
    const repl = vi.fn();
    p.command("repl", { isDefault: true }).action(repl);
    await runPassthrough(p, ["--json"], io);
    await runPassthrough(p, ["nonsense"], io);
    expect(repl).not.toHaveBeenCalled();
    expect(lines).toEqual(["No such command: --json", "No such command: nonsense"]);
  });
  it("won't read stdin, which belongs to the REPL", async () => {
    const { lines, io, p } = setup();
    await runPassthrough(p, ["hello", "--stdin"], io);
    expect(lines).toEqual(["bsky hello can't read from stdin inside the REPL"]);
  });
});

describe("passthroughFlags", () => {
  it("lists a command's long flags", () => {
    expect(passthroughFlags(program(), "hello")).toContain("--loud");
  });
  it("has none for a command that isn't there", () => {
    expect(passthroughFlags(program(), "nope")).toEqual([]);
  });
});

describe("passthroughNames", () => {
  it("lists what can be run, leaving out hidden commands", () => {
    const names = passthroughNames(program());
    expect(names).toContain("hello");
    expect(names).toContain("schedule");
    expect(names).not.toContain("hidden");
  });
  it("leaves out what can never run", () => {
    expect(passthroughNames(program())).not.toContain("login");
  });
});
