import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bskyDir } from "@/config";
import { trimSchedulerLog } from "@/lib/scheduler";

describe("trimSchedulerLog", () => {
  let home: string;
  const log = () => join(bskyDir(), "scheduler.log");
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bsky-log-"));
    vi.stubEnv("XDG_CONFIG_HOME", home);
    mkdirSync(bskyDir(), { recursive: true });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("leaves a small log alone", () => {
    writeFileSync(log(), "one line\n");
    trimSchedulerLog();
    expect(readFileSync(log(), "utf-8")).toBe("one line\n");
  });
  it("cuts a big log down to its newest lines, whole", () => {
    const lines = Array.from({ length: 100_000 }, (_, i) => `line ${i} of a failing job`).join("\n") + "\n";
    writeFileSync(log(), lines);
    trimSchedulerLog();
    const kept = readFileSync(log(), "utf-8");
    expect(statSync(log()).size).toBeLessThan(300_000);
    expect(kept.endsWith("line 99999 of a failing job\n")).toBe(true);
    expect(kept.startsWith("line ")).toBe(true);
  });
  it("is fine with no log yet", () => {
    expect(() => trimSchedulerLog()).not.toThrow();
  });
});
