import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("@/config", () => ({
  bskyDir: vi.fn(() => "/mock/bsky-cli"),
}));

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import {
  schedulerProfile,
  enableScheduler,
  disableScheduler,
  getSchedulerStatus,
  uninstallScheduler,
  bskyCommand,
} from "./scheduler";

const originalPlatform = process.platform;
const originalArgv = process.argv;

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, writable: true });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("XDG_CONFIG_HOME", "");
  process.argv = ["node", "/usr/local/bin/bsky"];
  Object.defineProperty(process, "execPath", { value: "/usr/bin/node", configurable: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  process.argv = originalArgv;
});

describe("bskyCommand", () => {
  const execPath = process.execPath;
  const runningAs = (path: string) => Object.defineProperty(process, "execPath", { value: path, configurable: true });
  afterEach(() => runningAs(execPath));

  it("names Node in full, as a job has no PATH to find it on", () => {
    runningAs("/home/me/.nvm/versions/node/v22.22.0/bin/node");
    process.argv = ["node", "/usr/local/bin/bsky"];
    expect(bskyCommand()).toEqual(["/home/me/.nvm/versions/node/v22.22.0/bin/node", "/usr/local/bin/bsky"]);
  });
  it("names Bun the same way", () => {
    runningAs("/opt/homebrew/bin/bun");
    process.argv = ["bun", "/usr/local/bin/bsky"];
    expect(bskyCommand()).toEqual(["/opt/homebrew/bin/bun", "/usr/local/bin/bsky"]);
  });
  it("knows Node and Bun by the other names they're installed under", () => {
    for (const runtime of ["/usr/bin/nodejs", "/usr/local/bin/node22", "/opt/bin/bun-debug"]) {
      runningAs(runtime);
      process.argv = ["node", "/usr/local/bin/bsky"];
      expect(bskyCommand()).toEqual([runtime, "/usr/local/bin/bsky"]);
    }
  });
  it("names Homebrew's stable link, as an upgrade removes the versioned folder", () => {
    runningAs("/opt/homebrew/Cellar/node@22/22.1.0/bin/node");
    process.argv = ["node", "/opt/homebrew/bin/bsky"];
    expect(bskyCommand()).toEqual(["/opt/homebrew/opt/node@22/bin/node", "/opt/homebrew/bin/bsky"]);
  });
  it("does the same for a compiled binary installed with Homebrew", () => {
    runningAs("/usr/local/Cellar/bsky-cli/1.9.1/bin/bsky");
    process.argv = ["bun", "/$bunfs/root/bsky"];
    expect(bskyCommand()).toEqual(["/usr/local/opt/bsky-cli/bin/bsky"]);
  });
  it("makes the script's path absolute", () => {
    runningAs("/usr/bin/node");
    process.argv = ["node", "dist/index.js"];
    expect(bskyCommand()[1]).toMatch(/^\/.*dist\/index\.js$/);
  });
  it("is just the binary when compiled, as argv[1] is a path inside it", () => {
    runningAs("/usr/local/bin/bsky");
    process.argv = ["bun", "/$bunfs/root/bsky"];
    expect(bskyCommand()).toEqual(["/usr/local/bin/bsky"]);
  });
  it("copes with Windows", () => {
    runningAs("C:\\Program Files\\nodejs\\node.exe");
    process.argv = ["node", "C:\\bsky\\index.js"];
    expect(bskyCommand()[0]).toBe("C:\\Program Files\\nodejs\\node.exe");
    expect(bskyCommand()).toHaveLength(2);
  });
});

// ── Linux ────────────────────────────────────────────────────────────

describe("Linux (crontab)", () => {
  beforeEach(() => setPlatform("linux"));

  describe("enableScheduler", () => {
    const crontabLine = () => {
      vi.mocked(execFileSync).mockReturnValueOnce("" as never); // crontab -l
      enableScheduler(1);
      return (vi.mocked(execFileSync).mock.calls.at(-1)![2] as { input: string }).input;
    };

    it("passes the config folder on, as a job doesn't get the shell's environment", () => {
      vi.stubEnv("XDG_CONFIG_HOME", "/home/me/my config");
      expect(crontabLine()).toContain("* * * * * XDG_CONFIG_HOME='/home/me/my config' '/usr/bin/node'");
    });
    it("sets nothing when the folder is the default one", () => {
      vi.stubEnv("XDG_CONFIG_HOME", "");
      expect(crontabLine()).not.toContain("XDG_CONFIG_HOME");
    });
    it("adds a crontab entry with the marker", () => {
      vi.mocked(execFileSync).mockReturnValueOnce("" as never); // crontab -l

      enableScheduler(1);

      expect(execFileSync).toHaveBeenCalledWith(
        "crontab",
        ["-"],
        expect.objectContaining({
          input: expect.stringContaining("* * * * * '/usr/bin/node' '/usr/local/bin/bsky' schedule run # bsky-cli-scheduler"),
        }),
      );
    });

    it("uses interval in cron expression", () => {
      vi.mocked(execFileSync).mockReturnValueOnce("" as never);

      enableScheduler(5);

      expect(execFileSync).toHaveBeenCalledWith(
        "crontab",
        ["-"],
        expect.objectContaining({
          input: expect.stringContaining("*/5 * * * *"),
        }),
      );
    });

    it("replaces existing marker entry", () => {
      vi.mocked(execFileSync).mockReturnValueOnce(
        "0 * * * * other-job\n* * * * * /old/bsky schedule run # bsky-cli-scheduler\n" as never,
      );

      enableScheduler(1);

      const call = vi.mocked(execFileSync).mock.calls[1];
      const input = (call[2] as { input: string }).input;
      expect(input).not.toContain("/old/bsky");
      expect(input).toContain("other-job");
      expect(input).toContain("'/usr/local/bin/bsky' schedule run # bsky-cli-scheduler");
    });

    it("refuses a profile that would change the scheduled command", () => {
      expect(() => enableScheduler(1, "x'; touch /tmp/pwned; '")).toThrow("Can't schedule for profile");
    });

    it("includes profile flag when set", () => {
      vi.mocked(execFileSync).mockReturnValueOnce("" as never);

      enableScheduler(1, "work");

      expect(execFileSync).toHaveBeenCalledWith(
        "crontab",
        ["-"],
        expect.objectContaining({
          input: expect.stringContaining("-p 'work'"),
        }),
      );
    });
  });

  describe("disableScheduler", () => {
    it("prefixes active marker line with # DISABLED", () => {
      vi.mocked(execFileSync).mockReturnValueOnce(
        "* * * * * /usr/local/bin/bsky schedule run # bsky-cli-scheduler\n" as never,
      );

      disableScheduler();

      expect(execFileSync).toHaveBeenCalledWith(
        "crontab",
        ["-"],
        expect.objectContaining({
          input: expect.stringContaining("# DISABLED * * * * * /usr/local/bin/bsky schedule run # bsky-cli-scheduler"),
        }),
      );
    });

    it("does not double-prefix already disabled line", () => {
      vi.mocked(execFileSync).mockReturnValueOnce(
        "# DISABLED * * * * * /usr/local/bin/bsky schedule run # bsky-cli-scheduler\n" as never,
      );

      disableScheduler();

      const call = vi.mocked(execFileSync).mock.calls[1];
      const input = (call[2] as { input: string }).input;
      expect(input).not.toContain("# DISABLED # DISABLED");
    });
  });

  describe("getSchedulerStatus", () => {
    it("returns 'not installed' when no marker line exists", () => {
      vi.mocked(execFileSync).mockReturnValueOnce("0 * * * * other-job\n" as never);
      expect(getSchedulerStatus()).toBe("not installed");
    });

    it("returns 'enabled' for active marker line", () => {
      vi.mocked(execFileSync).mockReturnValueOnce(
        "* * * * * /usr/local/bin/bsky schedule run # bsky-cli-scheduler\n" as never,
      );
      expect(getSchedulerStatus()).toBe("enabled");
    });

    it("returns 'disabled' for commented-out marker line", () => {
      vi.mocked(execFileSync).mockReturnValueOnce(
        "# DISABLED * * * * * /usr/local/bin/bsky schedule run # bsky-cli-scheduler\n" as never,
      );
      expect(getSchedulerStatus()).toBe("disabled");
    });
  });

  describe("uninstallScheduler", () => {
    it("removes the marker line entirely", () => {
      vi.mocked(execFileSync).mockReturnValueOnce(
        "0 * * * * other-job\n* * * * * /usr/local/bin/bsky schedule run # bsky-cli-scheduler\n" as never,
      );

      uninstallScheduler();

      const call = vi.mocked(execFileSync).mock.calls[1];
      const input = (call[2] as { input: string }).input;
      expect(input).toContain("other-job");
      expect(input).not.toContain("bsky-cli-scheduler");
    });
  });
});

// ── macOS ────────────────────────────────────────────────────────────

describe("macOS (launchd)", () => {
  beforeEach(() => setPlatform("darwin"));

  describe("enableScheduler", () => {
    const plist = () => {
      vi.mocked(existsSync).mockReturnValue(false);
      enableScheduler(1);
      return vi.mocked(writeFileSync).mock.calls[0][1] as string;
    };

    it("passes the config folder on, as launchd doesn't read the shell's environment", () => {
      vi.stubEnv("XDG_CONFIG_HOME", "/Users/me/.config");
      expect(plist()).toMatch(
        /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>XDG_CONFIG_HOME<\/key>\s*<string>\/Users\/me\/\.config<\/string>/,
      );
    });
    it("sets nothing when the folder is the default one", () => {
      vi.stubEnv("XDG_CONFIG_HOME", "");
      expect(plist()).not.toContain("EnvironmentVariables");
    });
    it("runs Node with the script, so the job doesn't need a PATH", () => {
      expect(plist()).toMatch(/<string>\/usr\/bin\/node<\/string>\s*<string>\/usr\/local\/bin\/bsky<\/string>\s*<string>schedule<\/string>/);
    });
    it("writes plist and loads with launchctl", () => {
      vi.mocked(existsSync).mockReturnValue(false);

      enableScheduler(1);

      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining("com.bsky-cli.scheduler.plist"),
        expect.stringContaining("<key>StartInterval</key>"),
      );
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("<integer>60</integer>"),
      );
      expect(execFileSync).toHaveBeenCalledWith("launchctl", [
        "load",
        expect.stringContaining("com.bsky-cli.scheduler.plist"),
      ]);
    });

    it("uses interval * 60 for StartInterval", () => {
      vi.mocked(existsSync).mockReturnValue(false);

      enableScheduler(5);

      expect(writeFileSync).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("<integer>300</integer>"),
      );
    });

    it("includes profile in ProgramArguments", () => {
      vi.mocked(existsSync).mockReturnValue(false);

      enableScheduler(1, "work");

      expect(writeFileSync).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("--profile"),
      );
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("work"),
      );
    });

    it("unloads existing plist before rewriting", () => {
      vi.mocked(existsSync).mockReturnValue(true);

      enableScheduler(1);

      expect(execFileSync).toHaveBeenCalledWith("launchctl", [
        "unload",
        expect.stringContaining("com.bsky-cli.scheduler.plist"),
      ]);
    });
  });

  describe("disableScheduler", () => {
    it("calls launchctl unload without deleting plist", () => {
      disableScheduler();

      expect(execFileSync).toHaveBeenCalledWith("launchctl", [
        "unload",
        expect.stringContaining("com.bsky-cli.scheduler.plist"),
      ]);
      expect(unlinkSync).not.toHaveBeenCalled();
    });
  });

  describe("getSchedulerStatus", () => {
    it("returns 'not installed' when plist does not exist", () => {
      vi.mocked(existsSync).mockReturnValue(false);
      expect(getSchedulerStatus()).toBe("not installed");
    });

    it("returns 'enabled' when launchctl list succeeds", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(execFileSync).mockReturnValueOnce("" as never);
      expect(getSchedulerStatus()).toBe("enabled");
    });

    it("returns 'disabled' when launchctl list fails", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(execFileSync).mockImplementationOnce(() => {
        throw new Error("Could not find service");
      });
      expect(getSchedulerStatus()).toBe("disabled");
    });
  });

  describe("uninstallScheduler", () => {
    it("unloads and deletes plist file", () => {
      vi.mocked(existsSync).mockReturnValue(true);

      uninstallScheduler();

      expect(execFileSync).toHaveBeenCalledWith("launchctl", [
        "unload",
        expect.stringContaining("com.bsky-cli.scheduler.plist"),
      ]);
      expect(unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining("com.bsky-cli.scheduler.plist"),
      );
    });
  });
});

// ── Windows ──────────────────────────────────────────────────────────

describe("Windows (schtasks)", () => {
  beforeEach(() => setPlatform("win32"));

  describe("enableScheduler", () => {
    it("quotes Node and the script apart", () => {
      enableScheduler(1);
      expect(vi.mocked(execFileSync).mock.calls[0][1]).toContain('"/usr/bin/node" "/usr/local/bin/bsky" schedule run');
    });
    it("creates schtasks with correct args", () => {
      enableScheduler(1);

      expect(execFileSync).toHaveBeenCalledWith("schtasks", [
        "/create",
        "/tn",
        "BskyCLI\\ScheduleRun",
        "/tr",
        expect.stringContaining("schedule run"),
        "/sc",
        "minute",
        "/mo",
        "1",
        "/f",
      ]);
    });

    it("uses custom interval", () => {
      enableScheduler(5);

      expect(execFileSync).toHaveBeenCalledWith(
        "schtasks",
        expect.arrayContaining(["/mo", "5"]),
      );
    });
  });

  describe("disableScheduler", () => {
    it("calls schtasks /change /disable", () => {
      disableScheduler();

      expect(execFileSync).toHaveBeenCalledWith("schtasks", [
        "/change",
        "/tn",
        "BskyCLI\\ScheduleRun",
        "/disable",
      ]);
    });
  });

  describe("getSchedulerStatus", () => {
    it("returns 'not installed' when query throws", () => {
      vi.mocked(execFileSync).mockImplementationOnce(() => {
        throw new Error("The system cannot find the path specified.");
      });
      expect(getSchedulerStatus()).toBe("not installed");
    });

    it("returns 'enabled' when status is Ready", () => {
      vi.mocked(execFileSync).mockReturnValueOnce("Status: Ready\n" as never);
      expect(getSchedulerStatus()).toBe("enabled");
    });

    it("returns 'disabled' when output contains Disabled", () => {
      vi.mocked(execFileSync).mockReturnValueOnce("Status: Disabled\n" as never);
      expect(getSchedulerStatus()).toBe("disabled");
    });
  });

  describe("uninstallScheduler", () => {
    it("calls schtasks /delete /f", () => {
      uninstallScheduler();

      expect(execFileSync).toHaveBeenCalledWith("schtasks", [
        "/delete",
        "/tn",
        "BskyCLI\\ScheduleRun",
        "/f",
      ]);
    });
  });
});

describe("schedulerProfile", () => {
  const plist = (args: string) => `<array>\n  <string>/bin/bsky</string>\n  <string>schedule</string>\n  <string>run</string>${args}\n</array>`;
  it.each([
    ["with one", "  <string>--profile</string>\n  <string>work</string>", "work"],
    ["without one", "", undefined],
  ])("reads a plist %s", (_, args, profile) => {
    setPlatform("darwin");
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(plist(args));
    expect(schedulerProfile()).toBe(profile);
  });
  it("has none with no plist", () => {
    setPlatform("darwin");
    vi.mocked(existsSync).mockReturnValue(false);
    expect(schedulerProfile()).toBeUndefined();
  });
  it("reads the crontab's own line", () => {
    setPlatform("linux");
    vi.mocked(execFileSync).mockReturnValue("* * * * * other -p 'nope'\n*/1 * * * * /bin/bsky schedule run -p 'work' # bsky-cli-scheduler\n");
    expect(schedulerProfile()).toBe("work");
  });
  it("reads a Windows task", () => {
    setPlatform("win32");
    vi.mocked(execFileSync).mockReturnValue('Task To Run:   "C:\\bsky.exe" schedule run -p "work"\n');
    expect(schedulerProfile()).toBe("work");
  });
});
