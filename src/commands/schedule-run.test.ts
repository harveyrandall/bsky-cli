import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { getClient } from "@/index";
import { createPost } from "@/commands/post";
import { registerSchedule } from "@/commands/schedule";
import { bskyDir } from "@/config";
import { saveScheduledPost, scheduledDir } from "@/scheduled";
import type { ScheduledPost } from "@/lib/types";

vi.mock("@/index", () => ({ getClient: vi.fn(), isJson: vi.fn(() => false) }));
vi.mock("@/commands/post", () => ({ createPost: vi.fn() }));

const DUE = "2026-01-10T09:00:00.000Z";
const PROFILES = [[undefined], ["work"]] as const;

/** Real files and real recurrence: only sending and signing in are faked. */
describe("schedule run, on real files", () => {
  let home: string;
  let errors: string[];
  let logged: string[];
  const agent = {} as Awaited<ReturnType<typeof getClient>>;

  const run = (profile?: string, ...argv: string[]) => {
    const program = new Command().exitOverride().option("-p, --profile <name>").option("--json");
    registerSchedule(program);
    return program.parseAsync([...(profile ? ["-p", profile] : []), "schedule", ...(argv.length ? argv : ["run"])], { from: "user" });
  };
  const queued = (o: Partial<ScheduledPost> = {}, profile?: string) => saveScheduledPost({ scheduledAt: DUE, text: "hello", ...o }, profile);
  const files = (profile?: string) => readdirSync(scheduledDir(profile));
  const onDisk = (file: string, profile?: string) => JSON.parse(readFileSync(join(scheduledDir(profile), file), "utf-8")) as ScheduledPost;
  const aged = (id: string, minutes: number, profile?: string) => {
    const then = new Date(Date.now() - minutes * 60_000);
    utimesSync(join(scheduledDir(profile), `${id}.sending`), then, then);
  };
  const leftBehind = async (o: Partial<ScheduledPost> = {}, profile?: string) => {
    const { id } = await queued(o, profile);
    const dir = scheduledDir(profile);
    writeFileSync(join(dir, `${id}.sending`), readFileSync(join(dir, `${id}.json`)));
    rmSync(join(dir, `${id}.json`));
    aged(id, 120, profile);
    return id;
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bsky-run-"));
    vi.stubEnv("XDG_CONFIG_HOME", home);
    vi.resetAllMocks();
    vi.mocked(getClient).mockResolvedValue(agent);
    vi.mocked(createPost).mockResolvedValue({ uri: "at://ok", cid: "cid" });
    errors = [];
    logged = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => void errors.push(line));
    vi.spyOn(console, "log").mockImplementation((line: string) => void logged.push(line));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  describe.each(PROFILES)("with profile %s", (profile) => {
    it("sends a post and leaves nothing behind", async () => {
      await queued({}, profile);
      await run(profile);
      expect(createPost).toHaveBeenCalledOnce();
      expect(files(profile)).toEqual([]);
    });
    it("puts a post back if it couldn't be sent", async () => {
      const { id } = await queued({}, profile);
      vi.mocked(createPost).mockRejectedValueOnce(new Error("Network timeout"));
      await run(profile);
      expect(files(profile)).toEqual([`${id}.json`]);
    });
    it("leaves a recurring post ready for its next run, in one file", async () => {
      const { id } = await queued({ rrule: "FREQ=DAILY;COUNT=5", remainingCount: 3 }, profile);
      await run(profile);
      expect(files(profile)).toEqual([`${id}.json`]);
      expect(onDisk(`${id}.json`, profile)).toMatchObject({ scheduledAt: "2026-01-11T09:00:00.000Z", remainingCount: 2, rrule: "FREQ=DAILY;COUNT=2" });
    });
    it("warns about a post left behind, with the file to rename", async () => {
      const id = await leftBehind({}, profile);
      await run(profile);
      expect(errors.join()).toContain(`rename it to ${id}.json to send it`);
      expect(errors.join()).toContain(join(scheduledDir(profile), `${id}.sending`));
      expect(createPost).not.toHaveBeenCalled();
    });
  });

  describe("a recurring post", () => {
    it("has one run left at a count of 2", async () => {
      const { id } = await queued({ rrule: "FREQ=DAILY;COUNT=2", remainingCount: 2 });
      await run();
      expect(onDisk(`${id}.json`)).toMatchObject({ remainingCount: 1 });
    });
    it("ends at a count of 1", async () => {
      await queued({ rrule: "FREQ=DAILY;COUNT=1", remainingCount: 1 });
      await run();
      expect(files()).toEqual([]);
    });
    it("keeps going with no count", async () => {
      const { id } = await queued({ rrule: "FREQ=DAILY" });
      await run();
      expect(onDisk(`${id}.json`)).toMatchObject({ scheduledAt: "2026-01-11T09:00:00.000Z", rrule: "FREQ=DAILY" });
    });
    it("ends if its rule can't be read", async () => {
      await queued({ rrule: "nonsense" });
      await run();
      expect(files()).toEqual([]);
    });
    it("says the series stopped if its next run can't be saved, and how to start it again", async () => {
      const { id } = await queued({ rrule: "FREQ=DAILY;COUNT=5", remainingCount: 3 });
      mkdirSync(join(scheduledDir(), `${id}.next`)); // in the way of the file being written
      await run();
      expect(logged).toEqual(["at://ok"]);
      expect(errors.join()).toContain(`couldn't save its next run (2026-01-11T09:00:00.000Z)`);
      expect(errors.join()).toContain("The series has stopped");
      expect(errors.join()).toContain(`rename it to ${id}.json`);
      expect(onDisk(`${id}.sending`).scheduledAt).toBe(DUE);
    });
  });

  describe("two runs at once", () => {
    /** A run that's listed the queue and then stalls, as a slow login would, until `go`. */
    const stalled = () => {
      let go = () => {};
      vi.mocked(getClient).mockImplementationOnce(() => new Promise((resolve) => (go = () => resolve(agent))));
      return { finished: run(), go: () => go() };
    };
    const listed = () => vi.waitFor(() => expect(getClient).toHaveBeenCalled());

    it("won't send a recurring post's next run from a list made before this one", async () => {
      const { id } = await queued({ rrule: "FREQ=DAILY;COUNT=5", remainingCount: 3 });
      const first = stalled();
      await listed();
      await run();
      first.go();
      await first.finished;
      expect(createPost).toHaveBeenCalledOnce();
      expect(files()).toEqual([`${id}.json`]);
      expect(onDisk(`${id}.json`)).toMatchObject({ remainingCount: 2 });
    });
    it("won't send a post the other run has already sent", async () => {
      await queued();
      const first = stalled();
      await listed();
      await run();
      first.go();
      await first.finished;
      expect(createPost).toHaveBeenCalledOnce();
    });
    it("sends what's in the file, as it may have been edited since the list", async () => {
      const { id } = await queued();
      const first = stalled();
      await listed();
      writeFileSync(join(scheduledDir(), `${id}.json`), JSON.stringify({ ...onDisk(`${id}.json`), text: "edited" }));
      first.go();
      await first.finished;
      expect(vi.mocked(createPost).mock.lastCall?.[1]).toBe("edited");
    });
  });

  describe("a post left behind", () => {
    it("uses only its first line", async () => {
      await leftBehind({ text: "first\nsecond" });
      await run();
      expect(errors.join()).toContain('("first")');
      expect(errors.join()).not.toContain("second");
    });
    it("is one a run may have stopped on, as that can't be known", async () => {
      await leftBehind();
      await run();
      expect(errors.join()).toContain("A run may have stopped while sending");
      expect(errors.join()).toContain("Check your Bluesky profile");
    });
    it("explains what each choice does to a series", async () => {
      await leftBehind({ rrule: "FREQ=DAILY" });
      await run();
      expect(errors.join()).toContain("deleting it ends the series");
      expect(errors.join()).toContain("change its scheduledAt to the next date first");
    });
    it("doesn't talk about series for a one-off", async () => {
      await leftBehind();
      await run();
      expect(errors.join()).not.toContain("series");
    });
    it("is named even if it can't be read, and doesn't stop the queue", async () => {
      const id = await leftBehind();
      writeFileSync(join(scheduledDir(), `${id}.sending`), "{ cut sho");
      aged(id, 120);
      await queued({ text: "the next one" });
      await run();
      expect(errors.join()).toContain(`${id}.sending holds a post that may not have gone out, and it can't be read`);
      expect(vi.mocked(createPost).mock.lastCall?.[1]).toBe("the next one");
    });
    it("can't stop the queue by having no text", async () => {
      const id = await leftBehind();
      writeFileSync(join(scheduledDir(), `${id}.sending`), JSON.stringify({ id }));
      aged(id, 120);
      await queued();
      await expect(run()).resolves.toBeDefined();
      expect(createPost).toHaveBeenCalledOnce();
    });
    it("goes unmentioned while it may still be sending", async () => {
      const id = await leftBehind();
      aged(id, 59);
      await run();
      expect(errors).toEqual([]);
    });
    it("is mentioned after an hour", async () => {
      const id = await leftBehind();
      aged(id, 61);
      await run();
      expect(errors.join()).toContain(id);
    });
    it("is mentioned if the clock has moved a long way", async () => {
      const id = await leftBehind();
      aged(id, -600);
      await run();
      expect(errors.join()).toContain(id);
    });
  });

  describe("schedule list", () => {
    it("shows a post being sent, rather than saying the queue's empty", async () => {
      const id = await leftBehind();
      aged(id, 1);
      await run(undefined, "list");
      expect(errors.join()).toContain(`${id} is being sent`);
      expect(errors.join()).not.toContain("No scheduled posts");
    });
    it("shows a post left behind", async () => {
      const id = await leftBehind();
      await run(undefined, "list");
      expect(errors.join()).toContain(`${id} may have gone out`);
      expect(errors.join()).toContain(`${id}.sending`);
    });
    it("still says so when there's nothing at all", async () => {
      await run(undefined, "list");
      expect(errors).toEqual(["No scheduled posts."]);
    });
    it("keeps its output clean", async () => {
      await leftBehind();
      await run(undefined, "list");
      expect(logged).toEqual([]);
    });
  });

  describe("exit code", () => {
    afterEach(() => {
      process.exitCode = undefined;
    });

    it("is 1 when posts were due and none went", async () => {
      await queued();
      await queued();
      vi.mocked(createPost).mockRejectedValue(new Error("server said no"));
      await run();
      expect(process.exitCode).toBe(1);
    });

    it.skipIf(process.getuid?.() === 0)("is 1 when a due post couldn't be taken from the queue", async () => {
      await queued();
      chmodSync(scheduledDir(), 0o555);
      try {
        await run();
      } finally {
        chmodSync(scheduledDir(), 0o755);
      }
      expect(process.exitCode).toBe(1);
    });

    it("stays 0 when at least one went", async () => {
      await queued();
      await queued();
      vi.mocked(createPost)
        .mockRejectedValueOnce(new Error("server said no"))
        .mockResolvedValueOnce({ uri: "at://did:plc:me/app.bsky.feed.post/1", cid: "c" });
      await run();
      expect(process.exitCode).toBeUndefined();
    });

    it("stays 0 when nothing was due", async () => {
      await run();
      expect(process.exitCode).toBeUndefined();
    });

    it("stays 0 when an overlapping run took them, as nothing failed", async () => {
      await queued();
      vi.mocked(createPost).mockResolvedValue({ uri: "at://did:plc:me/app.bsky.feed.post/1", cid: "c" });
      await Promise.all([run(), run()]);
      expect(createPost).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBeUndefined();
    });
  });

  it("cuts the job's log first, so a run that fails still does", async () => {
    await queued();
    const log = join(bskyDir(), "scheduler.log");
    writeFileSync(log, "a line from the job\n".repeat(100_000));
    rmSync(scheduledDir(), { recursive: true });
    writeFileSync(scheduledDir(), "a file where the folder should be");
    await expect(run()).rejects.toThrow();
    expect(statSync(log).size).toBeLessThan(300_000);
  });

  it("fails rather than call an unreadable queue empty", async () => {
    await queued();
    mkdirSync(join(home, "stray"));
    rmSync(scheduledDir(), { recursive: true });
    writeFileSync(scheduledDir(), "a file where the folder should be");
    await expect(run()).rejects.toThrow();
    expect(existsSync(scheduledDir())).toBe(true);
  });
});
