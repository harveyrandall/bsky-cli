import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock("@/config", () => ({
  bskyDir: vi.fn(() => "/mock/bsky-cli"),
}));

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import {
  enableScheduler,
  disableScheduler,
  getSchedulerStatus,
  uninstallScheduler,
  resolveBskyPath,
} from "./scheduler";

const originalPlatform = process.platform;
const originalArgv = process.argv;

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, writable: true });
}

beforeEach(() => {
  vi.resetAllMocks();
  process.argv = ["node", "/usr/local/bin/bsky"];
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  process.argv = originalArgv;
});

describe("resolveBskyPath", () => {
  it("resolves process.argv[1] to absolute path", () => {
    process.argv = ["node", "/usr/local/bin/bsky"];
    expect(resolveBskyPath()).toBe("/usr/local/bin/bsky");
  });
});

// ── Linux ────────────────────────────────────────────────────────────

describe("Linux (crontab)", () => {
  beforeEach(() => setPlatform("linux"));

  describe("enableScheduler", () => {
    it("adds a crontab entry with the marker", () => {
      vi.mocked(execFileSync).mockReturnValueOnce("" as never); // crontab -l

      enableScheduler(1);

      expect(execFileSync).toHaveBeenCalledWith(
        "crontab",
        ["-"],
        expect.objectContaining({
          input: expect.stringContaining("* * * * * /usr/local/bin/bsky schedule run # bsky-cli-scheduler"),
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
      expect(input).toContain("/usr/local/bin/bsky schedule run # bsky-cli-scheduler");
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
