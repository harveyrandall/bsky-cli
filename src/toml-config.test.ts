import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync, mkdtempSync, readFileSync, rmSync, readdirSync, renameSync, statSync, chmodSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";

vi.mock("@/config", () => ({
  bskyDir: vi.fn(() => "/mock/bsky-cli"),
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});

import {
  activeConfigPath,
  setConfigValues,
  configFilePath,
  loadTomlConfig,
  applyConfigToProgram,
  generateDefaultConfig,
} from "./toml-config";

// ── configFilePath ──────────────────────────────────────────────────

describe("configFilePath", () => {
  const savedBskyConfig = process.env.BSKY_CONFIG;

  afterEach(() => {
    if (savedBskyConfig !== undefined) {
      process.env.BSKY_CONFIG = savedBskyConfig;
    } else {
      delete process.env.BSKY_CONFIG;
    }
  });

  it("returns override path when provided", () => {
    expect(configFilePath("/tmp/custom.toml")).toBe("/tmp/custom.toml");
  });

  it("returns override path even when BSKY_CONFIG is set", () => {
    process.env.BSKY_CONFIG = "/env/config.toml";
    expect(configFilePath("/tmp/custom.toml")).toBe("/tmp/custom.toml");
  });

  it("returns BSKY_CONFIG env var when no override", () => {
    process.env.BSKY_CONFIG = "/env/config.toml";
    expect(configFilePath()).toBe("/env/config.toml");
  });

  it("returns default path when no override and no env var", () => {
    delete process.env.BSKY_CONFIG;
    expect(configFilePath()).toBe("/mock/bsky-cli/config.toml");
  });

  it("returns default path for undefined override without env var", () => {
    delete process.env.BSKY_CONFIG;
    expect(configFilePath(undefined)).toBe("/mock/bsky-cli/config.toml");
  });
});

// ── loadTomlConfig ──────────────────────────────────────────────────

describe("loadTomlConfig", () => {
  it("returns empty object for non-existent file", () => {
    expect(loadTomlConfig("/does/not/exist.toml")).toEqual({});
  });

  it("parses valid TOML", () => {
    const tmpFile = "/tmp/bsky-test-config.toml";
    writeFileSync(tmpFile, 'json = true\nprofile = "work"\n\n[post]\nstdin = true\n');
    try {
      const result = loadTomlConfig(tmpFile);
      expect(result).toEqual({
        json: true,
        profile: "work",
        post: { stdin: true },
      });
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it("throws on invalid TOML with clear message", () => {
    const tmpFile = "/tmp/bsky-test-bad.toml";
    writeFileSync(tmpFile, "[invalid\nbroken toml");
    try {
      expect(() => loadTomlConfig(tmpFile)).toThrow(/Failed to parse config file/);
    } finally {
      unlinkSync(tmpFile);
    }
  });
});

// ── applyConfigToProgram ────────────────────────────────────────────

function buildTestProgram(): Command {
  const program = new Command();
  program
    .option("--json", "Output as JSON")
    .option("-p, --profile <name>", "Profile name")
    .option("-v, --verbose", "Verbose output")
    .option("-c, --config <path>", "Config path");

  const timeline = program.command("timeline");
  timeline.option("-n <count>", "Number of items", "30");

  const thread = program.command("thread");
  thread.option("-n <count>", "Number of items", "30");

  const search = program.command("search");
  search.option("-n <count>", "Number of results", "100");

  const createThread = program.command("create-thread");
  createThread
    .option("--thread-label", "Add thread label")
    .option("--prepend-thread-label", "Put label at start")
    .option("--no-preview", "Skip interactive preview")
    .option("--skip-validation", "Skip validation")
    .option("--media-all", "Attach same media to every post");

  const schedule = program.command("schedule");
  const scheduleList = schedule.command("list");
  scheduleList
    .option("-n, --number <num>", "Number", "5")
    .option("-o, --order <order>", "Sort order", "asc");
  schedule.command("post").option("--stdin", "Read from stdin");

  const bookmarks = program.command("bookmarks");
  bookmarks.command("get").option("-n, --count <number>", "Count", "50");

  return program;
}

describe("applyConfigToProgram", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.BSKY_PROFILE = process.env.BSKY_PROFILE;
    delete process.env.BSKY_PROFILE;
  });

  afterEach(() => {
    if (savedEnv.BSKY_PROFILE !== undefined) {
      process.env.BSKY_PROFILE = savedEnv.BSKY_PROFILE;
    } else {
      delete process.env.BSKY_PROFILE;
    }
  });

  it("applies global options", () => {
    const program = buildTestProgram();
    applyConfigToProgram(program, { json: true, verbose: true });
    expect(program.opts().json).toBe(true);
    expect(program.opts().verbose).toBe(true);
  });

  it("applies global profile", () => {
    const program = buildTestProgram();
    applyConfigToProgram(program, { profile: "work" });
    expect(program.opts().profile).toBe("work");
  });

  it("applies command-level options", () => {
    const program = buildTestProgram();
    applyConfigToProgram(program, {
      "create-thread": {
        "thread-label": true,
        "media-all": true,
      },
    });
    const cmd = program.commands.find((c) => c.name() === "create-thread")!;
    expect(cmd.opts().threadLabel).toBe(true);
    expect(cmd.opts().mediaAll).toBe(true);
  });

  it("handles key mapping (count → n) for timeline", () => {
    const program = buildTestProgram();
    applyConfigToProgram(program, { timeline: { count: 50 } });
    const cmd = program.commands.find((c) => c.name() === "timeline")!;
    expect(cmd.opts().n).toBe(50);
  });

  it("handles key mapping (count → n) for search", () => {
    const program = buildTestProgram();
    applyConfigToProgram(program, { search: { count: 25 } });
    const cmd = program.commands.find((c) => c.name() === "search")!;
    expect(cmd.opts().n).toBe(25);
  });

  it("handles key mapping (count → number) for schedule list", () => {
    const program = buildTestProgram();
    applyConfigToProgram(program, { schedule: { list: { count: 10 } } });
    const schedule = program.commands.find((c) => c.name() === "schedule")!;
    const list = schedule.commands.find((c) => c.name() === "list")!;
    expect(list.opts().number).toBe(10);
  });

  it("handles nested subcommands (bookmarks.get)", () => {
    const program = buildTestProgram();
    applyConfigToProgram(program, { bookmarks: { get: { count: 20 } } });
    const bookmarks = program.commands.find((c) => c.name() === "bookmarks")!;
    const get = bookmarks.commands.find((c) => c.name() === "get")!;
    expect(get.opts().count).toBe(20);
  });

  it("handles negated boolean (no-preview)", () => {
    const program = buildTestProgram();
    applyConfigToProgram(program, {
      "create-thread": { "no-preview": true },
    });
    const cmd = program.commands.find((c) => c.name() === "create-thread")!;
    expect(cmd.opts().preview).toBe(false);
  });

  it("no-preview = false keeps preview enabled", () => {
    const program = buildTestProgram();
    applyConfigToProgram(program, {
      "create-thread": { "no-preview": false },
    });
    const cmd = program.commands.find((c) => c.name() === "create-thread")!;
    expect(cmd.opts().preview).toBe(true);
  });

  it("skips profile when BSKY_PROFILE env var is set", () => {
    process.env.BSKY_PROFILE = "env-profile";
    const program = buildTestProgram();
    applyConfigToProgram(program, { profile: "config-profile" });
    // Config value should NOT be applied when env var exists
    expect(program.opts().profile).toBeUndefined();
  });

  it("applies profile when BSKY_PROFILE is not set", () => {
    delete process.env.BSKY_PROFILE;
    const program = buildTestProgram();
    applyConfigToProgram(program, { profile: "config-profile" });
    expect(program.opts().profile).toBe("config-profile");
  });

  it("ignores unknown command sections", () => {
    const program = buildTestProgram();
    // Should not throw
    applyConfigToProgram(program, { "nonexistent-cmd": { foo: true } });
  });

  it("ignores unknown nested subcommand sections", () => {
    const program = buildTestProgram();
    // Should not throw
    applyConfigToProgram(program, { schedule: { nonexistent: { foo: true } } });
  });

  it("applies multiple command sections at once", () => {
    const program = buildTestProgram();
    applyConfigToProgram(program, {
      json: true,
      timeline: { count: 50 },
      "create-thread": { "thread-label": true },
    });
    expect(program.opts().json).toBe(true);
    const tl = program.commands.find((c) => c.name() === "timeline")!;
    expect(tl.opts().n).toBe(50);
    const ct = program.commands.find((c) => c.name() === "create-thread")!;
    expect(ct.opts().threadLabel).toBe(true);
  });

  it("applies schedule.list order option", () => {
    const program = buildTestProgram();
    applyConfigToProgram(program, { schedule: { list: { order: "desc" } } });
    const schedule = program.commands.find((c) => c.name() === "schedule")!;
    const list = schedule.commands.find((c) => c.name() === "list")!;
    expect(list.opts().order).toBe("desc");
  });
});

// ── generateDefaultConfig ───────────────────────────────────────────

describe("generateDefaultConfig", () => {
  it("returns a string", () => {
    expect(typeof generateDefaultConfig()).toBe("string");
  });

  it("contains all expected sections", () => {
    const config = generateDefaultConfig();
    const sections = [
      "[post]",
      "[reply]",
      "[quote]",
      "[create-thread]",
      "[repl]",
      "[timeline]",
      "[stream]",
      "[search]",
      "[search-users]",
      "[thread]",
      "[notifs]",
      "[login]",
      "[invite-codes]",
      "[mod-list]",
      "[bookmarks.get]",
      "[schedule.list]",
      "[schedule.watch]",
      "[schedule.enable]",
      "[schedule.post]",
    ];
    for (const section of sections) {
      expect(config).toContain(section);
    }
  });

  it("has all values commented out", () => {
    const config = generateDefaultConfig();
    const lines = config.split("\n").filter((l) => l.includes("="));
    for (const line of lines) {
      expect(line.trimStart()).toMatch(/^#/);
    }
  });

  it("contains global options", () => {
    const config = generateDefaultConfig();
    expect(config).toContain("# json = false");
    expect(config).toContain("# profile =");
    expect(config).toContain("# verbose = false");
  });
});

// ── activeConfigPath / setConfigValues ──────────────────────────────

describe("activeConfigPath", () => {
  it("prefers -c and --config", () => {
    expect(activeConfigPath(["node", "bsky", "-c", "/x.toml"])).toBe("/x.toml");
    expect(activeConfigPath(["node", "bsky", "--config", "/y.toml", "repl"])).toBe("/y.toml");
  });
  it("reads the path joined to its flag", () => {
    expect(activeConfigPath(["node", "bsky", "--config=/z.toml"])).toBe("/z.toml");
    expect(activeConfigPath(["node", "bsky", "-c/w.toml", "repl"])).toBe("/w.toml");
  });
  it("stops at --, where text can look like a flag", () => {
    expect(activeConfigPath(["node", "bsky", "post", "--", "-cool"])).toBe(configFilePath());
  });
  it("otherwise uses the usual lookup", () => {
    expect(activeConfigPath(["node", "bsky", "repl"])).toBe(configFilePath());
  });
});

describe("setConfigValues", () => {
  let dir: string;
  const file = () => join(dir, "config.toml");
  const read = () => readFileSync(file(), "utf-8");
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bsky-config-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("replaces a value and leaves everything else alone", async () => {
    writeFileSync(file(), "# mine\n[repl]\nundo = 5\n\n[post]\n# draft = false\n");
    await setConfigValues(file(), "repl", { undo: 10 });
    expect(read()).toBe("# mine\n[repl]\nundo = 10\n\n[post]\n# draft = false\n");
  });
  it("uncomments a documented key", async () => {
    writeFileSync(file(), "[repl]\n# undo = 5\n# pace = 0\n");
    await setConfigValues(file(), "repl", { undo: 10 });
    expect(read()).toBe("[repl]\nundo = 10\n# pace = 0\n");
  });
  it("inserts a missing key after the section header", async () => {
    writeFileSync(file(), "[repl]\n# notes\n[post]\n");
    await setConfigValues(file(), "repl", { pace: 5 });
    expect(read()).toBe("[repl]\npace = 5\n# notes\n[post]\n");
  });
  it("only touches keys inside the section", async () => {
    writeFileSync(file(), "[post]\n# undo = 1\n[repl]\n");
    await setConfigValues(file(), "repl", { undo: 5 });
    expect(read()).toBe("[post]\n# undo = 1\n[repl]\nundo = 5\n");
  });
  it("appends a missing section", async () => {
    writeFileSync(file(), "[post]\n# draft = false\n");
    await setConfigValues(file(), "repl", { undo: 5, "ask-to-save": false, "split-marker": "~~" });
    expect(read()).toBe('[post]\n# draft = false\n\n[repl]\nsplit-marker = "~~"\nask-to-save = false\nundo = 5\n');
  });
  it("creates the file from the default config", async () => {
    await setConfigValues(file(), "repl", { undo: 10 });
    expect(read()).toBe(generateDefaultConfig().replace("# undo = 5\n", "undo = 10\n"));
  });
  it("refuses to write a file that wouldn't parse, leaving the old one", async () => {
    writeFileSync(file(), "[repl\nundo = 5\n");
    await expect(setConfigValues(file(), "repl", { pace: 5 })).rejects.toThrow(`Couldn't update ${file()}`);
    expect(read()).toBe("[repl\nundo = 5\n");
    expect(readdirSync(dir)).toEqual(["config.toml"]);
  });
  it("finds a header with spaces or a comment", async () => {
    writeFileSync(file(), "[ repl ] # mine\nundo = 5\n");
    await setConfigValues(file(), "repl", { undo: 10 });
    expect(read()).toBe("[ repl ] # mine\nundo = 10\n");
  });
  it("keeps a comment at the end of a replaced line", async () => {
    writeFileSync(file(), '[repl]\nundo = 5 # quick\nsplit-marker = "#" # odd\n');
    await setConfigValues(file(), "repl", { undo: 10, "split-marker": "~~" });
    expect(read()).toBe('[repl]\nundo = 10 # quick\nsplit-marker = "~~" # odd\n');
  });
  it("writes through a symlink", async () => {
    const real = join(dir, "real.toml");
    writeFileSync(real, "[repl]\nundo = 5\n");
    symlinkSync(real, file());
    await setConfigValues(file(), "repl", { undo: 10 });
    expect(lstatSync(file()).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf-8")).toBe("[repl]\nundo = 10\n");
  });
  it("keeps the file's permissions", async () => {
    writeFileSync(file(), "[repl]\nundo = 5\n");
    chmodSync(file(), 0o600);
    await setConfigValues(file(), "repl", { undo: 10 });
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });
  it("names the config, and cleans up, when it can't put the new file in place", async () => {
    writeFileSync(file(), "[repl]\nundo = 5\n");
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error("EXDEV");
    });
    await expect(setConfigValues(file(), "repl", { undo: 10 })).rejects.toThrow(`Couldn't update ${file()}: EXDEV`);
    expect(read()).toBe("[repl]\nundo = 5\n");
    expect(readdirSync(dir)).toEqual(["config.toml"]);
  });
});
