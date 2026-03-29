import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { Command } from "commander";

vi.mock("@/config", () => ({
  bskyDir: vi.fn(() => "/mock/bsky-cli"),
}));

import {
  configFilePath,
  loadTomlConfig,
  applyConfigToProgram,
  generateDefaultConfig,
} from "./toml-config";

// ── configFilePath ──────────────────────────────────────────────────

describe("configFilePath", () => {
  it("returns override path when provided", () => {
    expect(configFilePath("/tmp/custom.toml")).toBe("/tmp/custom.toml");
  });

  it("returns default path when no override", () => {
    expect(configFilePath()).toBe("/mock/bsky-cli/config.toml");
  });

  it("returns default path for undefined override", () => {
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
