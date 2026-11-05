import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { BLOCKED, outsideCommands, passthroughFlags, passthroughKnows, passthroughNames, runPassthrough, uriArguments } from "./passthrough";

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

describe("what a run would really reach", () => {
  const withDefault = () => {
    const p = program().option("-c, --config <path>").version("1.2.3");
    const repl = vi.fn();
    p.command("repl", { isDefault: true }).action(repl);
    return { p, repl, lines: [] as string[] };
  };
  it.each([[["-p", "hello"]], [["-c", "hello"]], [["--", "-p", "hello"]], [["-V"]], [["-p"]]])("%j runs nothing, not even the default command", async (argv) => {
    const { p, repl, lines } = withDefault();
    expect(await runPassthrough(p, argv, { print: (text) => lines.push(text) })).toBe("keep");
    expect(repl).not.toHaveBeenCalled();
    expect(lines.join()).toContain("No such command");
  });
  it("sees a blocked command past an option's value", async () => {
    const { p, lines } = withDefault();
    await runPassthrough(p, ["-c", "hello", "login"], { print: (text) => lines.push(text) });
    expect(lines.join()).toContain("bsky login can't run inside the REPL");
  });
  it("sees a blocked subcommand past an option's value", async () => {
    const { p, lines } = withDefault();
    await runPassthrough(p, ["schedule", "-c", "list", "post"], { print: (text) => lines.push(text) });
    expect(lines.join()).toContain("bsky schedule post can't run inside the REPL");
  });
  it("isn't fooled the other way, by an option's value that names something blocked", async () => {
    const { p, lines } = withDefault();
    await runPassthrough(p, ["-p", "login", "hello"], { print: (text) => lines.push(text) });
    expect(lines).toContain("hello quiet");
  });
  it("leaves the real program's options alone", async () => {
    const { p } = withDefault();
    await runPassthrough(p, ["-p", "hello"], { print() {} });
    expect(p.opts().profile).toBeUndefined();
  });
});

describe("an unnamed profile after a /switch", () => {
  it("is passed on as empty, which beats a profile from the config", async () => {
    const p = program();
    p.setOptionValueWithSource("profile", "work", "config");
    const lines: string[] = [];
    await runPassthrough(p, ["who"], { print: (text) => lines.push(text), profile: "" });
    expect(lines).toEqual([""]);
  });
});

describe("a config file given at startup", () => {
  const whichConfig = () => {
    const p = program().option("-c, --config <path>");
    p.command("where").action(() => console.log(p.opts().config));
    return p;
  };
  it("stays, as Commander forgets it on each parse", async () => {
    const lines: string[] = [];
    await runPassthrough(whichConfig(), ["where"], { print: (text) => lines.push(text), config: "custom.toml" });
    expect(lines).toEqual(["custom.toml"]);
  });
  it("gives way to one in the command", async () => {
    const lines: string[] = [];
    await runPassthrough(whichConfig(), ["-c", "other.toml", "where"], { print: (text) => lines.push(text), config: "custom.toml" });
    expect(lines).toEqual(["other.toml"]);
  });
});

describe("putting everything back", () => {
  it("restores every stream and console method, even after a throw", async () => {
    const { stdout, stderr } = process;
    const before = [stdout.write, stderr.write, console.log, console.info, console.warn, console.error, process.exit];
    await runPassthrough(program(), ["boom"], { print() {} });
    expect([stdout.write, stderr.write, console.log, console.info, console.warn, console.error, process.exit]).toEqual(before);
  });
  it("doesn't catch what printing a line draws", async () => {
    const terminal = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const lines: string[] = [];
    const print = (text: string) => {
      lines.push(text);
      process.stdout.write("A FRAME");
    };
    await runPassthrough(program(), ["who"], { print });
    expect(terminal).toHaveBeenCalledWith("A FRAME");
    terminal.mockRestore();
    expect(lines).toEqual(["default"]);
  });
  it("reports a mistake once", async () => {
    const lines: string[] = [];
    await runPassthrough(program(), ["hello", "--nope"], { print: (text) => lines.push(text) });
    expect(lines.filter((l) => l.includes("--nope"))).toHaveLength(1);
  });
});

describe("what a run comes to", () => {
  it.each([
    [["hello"], "done"],
    [["hello", "--help"], "done"],
    [["quits"], "done"],
    [["hello", "--nope"], "keep"],
    [["bye"], "keep"],
    [["boom"], "keep"],
    [["failing"], "keep"],
    [["hello", "--stdin"], "keep"],
    [["nonsense"], "keep"],
  ])("%j is %s", async (argv, outcome) => {
    const p = program();
    p.command("quits").action(() => process.exit(0));
    expect(await runPassthrough(p, argv, { print() {} })).toBe(outcome);
  });
  it("clears a refused login, which may hold a password", async () => {
    expect(await runPassthrough(program(), ["login", "me", "secret"], { print() {} })).toBe("clear");
  });
  it("marks refusals and thrown errors as errors, after what was printed", async () => {
    const p = program();
    p.command("half").action(async () => {
      process.stdout.write("no newline");
      throw new Error("it broke");
    });
    const print = vi.fn();
    await runPassthrough(p, ["half"], { print });
    await runPassthrough(p, ["login"], { print });
    expect(print.mock.calls).toEqual([["no newline", undefined], ["it broke", "error"], [expect.stringContaining("bsky login"), "error"]]);
  });
});

describe("schedule uninstall", () => {
  it("is refused, as it asks a question that would take the terminal out of raw mode", async () => {
    const p = program();
    const action = vi.fn();
    p.commands.find((c) => c.name() === "schedule")!.command("uninstall").action(action);
    const printed: string[] = [];
    await runPassthrough(p, ["schedule", "uninstall"], { print: (text) => printed.push(text) });
    expect(action).not.toHaveBeenCalled();
    expect(printed.join()).toContain("bsky schedule uninstall can't run inside the REPL");
  });
});

describe("uriArguments", () => {
  const cli = () => {
    const p = program();
    p.command("thread").argument("<uri>").option("-n <count>");
    p.command("like").argument("<uri...>");
    p.command("post").argument("<text...>");
    p.command("reply").argument("<uri>").argument("<text...>");
    p.command("bookmarks").command("add").argument("<uri...>");
    return p;
  };
  it.each([
    [["thread", "#1"], [1]],
    [["thread", "-n", "5", "#1"], [3]],
    [["thread", "#1", "-n", "5"], [1]],
    [["like", "#1", "#2"], [1, 2]],
    [["post", "we", "are", "#1"], []],
    [["reply", "#1", "hi", "#2"], [1]],
    [["-p", "work", "thread", "#1"], [3]],
    [["bookmarks", "add", "#1"], [2]],
    [["nonsense", "#1"], []],
  ])("%j is %j", (argv, at) => {
    expect([...uriArguments(cli(), argv)]).toEqual(at);
  });
});

describe("outsideCommands", () => {
  it("keeps a frame out of a command's output, whoever scheduled it", async () => {
    const p = program();
    p.command("draws").action(async () => {
      setImmediate(() => outsideCommands(process.stdout).write("FRAME"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      console.log("done");
    });
    const terminal = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const printed: string[] = [];
    await runPassthrough(p, ["draws"], { print: (text) => printed.push(text) });
    expect(terminal).toHaveBeenCalledWith("FRAME");
    terminal.mockRestore();
    expect(printed).toEqual(["done"]);
  });
});

describe("passthroughKnows", () => {
  it("knows blocked commands and aliases, which /help and Tab leave out", () => {
    const p = program();
    p.commands.find((c) => c.name() === "hello")!.alias("hi");
    expect(passthroughKnows(p, "login")).toBe(true);
    expect(passthroughKnows(p, "hi")).toBe(true);
    expect(passthroughKnows(p, "nope")).toBe(false);
  });
});

describe("passthroughFlags", () => {
  it("lists a command's long flags", () => {
    expect(passthroughFlags(program(), "hello")).toContain("--loud");
  });
  it("lists the CLI's global flags too", () => {
    expect(passthroughFlags(program(), "hello")).toContain("--json");
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
