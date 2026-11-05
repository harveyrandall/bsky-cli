import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_MARKERS } from "@/repl/core/markers";
import { LEFT } from "@/repl/ui/App";
import { Registry } from "@/repl/core/refs";

import { SessionKeeper } from "@/repl/core/session";

const { render, detectKittyKeyboard, saveDraft, deleteDraft, readDrafts, setConfigValues, getSchedulerStatus, schedulerProfile, saveScheduledPost, setPostLabeler } = vi.hoisted(() => ({
  readDrafts: vi.fn(),
  setPostLabeler: vi.fn(),
  saveScheduledPost: vi.fn(),
  getSchedulerStatus: vi.fn(),
  schedulerProfile: vi.fn(),
  render: vi.fn(),
  detectKittyKeyboard: vi.fn(),
  saveDraft: vi.fn(),
  deleteDraft: vi.fn(),
  setConfigValues: vi.fn(),
}));
vi.mock("@/drafts", () => ({ saveDraft, deleteDraft, readDrafts }));
vi.mock("@/lib/format", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/format")>()), setPostLabeler }));
vi.mock("@/toml-config", () => ({ setConfigValues }));
vi.mock("@/lib/scheduler", () => ({ getSchedulerStatus, schedulerProfile }));
vi.mock("@/scheduled", () => ({ saveScheduledPost }));
vi.mock("ink", async (importOriginal) => ({ ...(await importOriginal<typeof import("ink")>()), render }));
vi.mock("@/repl/ui/terminal", () => ({ detectKittyKeyboard }));
const { startRepl, offlineProps, pickSession } = await import("@/repl");
const options = {
  markers: DEFAULT_MARKERS,
  settings: offlineProps.settings,
  agent: offlineProps.agent,
  handle: "me.bsky.social",
  configPath: "/tmp/config.toml",
};

/** An Ink instance whose exit promise settles when unmounted; like Ink's, unmount takes no error. */
function fakeInstance() {
  let settle: (err?: Error) => void = () => {};
  let finish: (value: unknown) => void = () => {};
  const exited = new Promise<unknown>((resolve, reject) => {
    settle = (err) => (err ? reject(err) : resolve(undefined));
    finish = resolve;
  });
  return { unmount: vi.fn(() => settle()), exit: (value: unknown) => finish(value), waitUntilExit: () => exited };
}

const added = (event: "uncaughtException" | "unhandledRejection", before: Function[]) =>
  process.listeners(event).filter((l) => !before.includes(l)) as unknown as ((err: unknown) => void)[];

beforeEach(() => {
  vi.clearAllMocks();
  detectKittyKeyboard.mockResolvedValue(true);
  process.exitCode = undefined; // an app that unmounts sets it, and a test checks it
});

describe("pickSession", () => {
  const listings = [{ id: "k3f7xq", updatedAt: "2026-11-04T10:00:00.000Z", summary: "", state: "ok" as const }];
  const pick = async (id: string | undefined | null) => {
    const app = fakeInstance();
    render.mockReturnValue(app);
    const store = { delete: vi.fn(async () => {}) };
    const picking = pickSession(store, listings);
    render.mock.lastCall?.[0].props.onPick(id);
    return { picked: await picking, store, props: render.mock.lastCall?.[0].props };
  };
  it("hands back what was picked", async () => {
    await expect(pick("k3f7xq").then((r) => r.picked)).resolves.toBe("k3f7xq");
    await expect(pick(undefined).then((r) => r.picked)).resolves.toBeUndefined();
    await expect(pick(null).then((r) => r.picked)).resolves.toBeNull();
  });
  it("deletes through the store", async () => {
    const { store, props } = await pick(undefined);
    await props.onDelete("zzzzzz");
    expect(store.delete).toHaveBeenCalledWith("zzzzzz");
  });
  it("hands stdin back: Ink lets go of it, and a question that follows would quit the process", async () => {
    const ref = vi.spyOn(process.stdin, "ref").mockReturnValue(process.stdin);
    await pick(undefined);
    expect(ref).toHaveBeenCalled();
    ref.mockRestore();
  });
});

describe("startRepl", () => {
  it.each([
    [true, false, "enabled"],
    [false, true, "disabled"],
  ])("with kitty support %s: hint %s, kitty keyboard %s, Ctrl+C left to the composer", async (kitty, hint, mode) => {
    detectKittyKeyboard.mockResolvedValue(kitty);
    const app = fakeInstance();
    render.mockReturnValue(app);
    const running = startRepl(options);
    await vi.waitFor(() => expect(render).toHaveBeenCalled());
    const [element, renderOptions] = render.mock.calls[0];
    expect(element.props).toMatchObject({ markers: DEFAULT_MARKERS, kittyHint: hint });
    expect(renderOptions).toMatchObject({ exitOnCtrlC: false, kittyKeyboard: { mode } });
    expect(renderOptions.stdout).not.toBe(process.stdout); // a frame can't be a command's output
    app.unmount();
    await running;
  });

  it("saves drafts to the profile and answers to the [repl] section of the active config", async () => {
    const app = fakeInstance();
    render.mockReturnValue(app);
    const running = startRepl({ ...options, profile: "work" });
    await vi.waitFor(() => expect(render).toHaveBeenCalled());
    const { drafts, saveConfig, saveScheduled, configName } = render.mock.calls[0][0].props;
    const draft = { reason: "manual", type: "post", text: "hi" };
    await drafts.save(draft);
    await drafts.delete("d1");
    await saveConfig({ undo: 5 });
    const post = { scheduledAt: "2099-01-01T00:00:00.000Z", text: "later" };
    await saveScheduled(post);
    expect(saveScheduledPost).toHaveBeenCalledWith(post, "work");
    expect(saveDraft).toHaveBeenCalledWith(draft, "work");
    expect(deleteDraft).toHaveBeenCalledWith("d1", "work");
    expect(setConfigValues).toHaveBeenCalledWith("/tmp/config.toml", "repl", { undo: 5 });
    expect(configName).toBe("config.toml");
    app.unmount();
    await running;
  });

  it("labels what the CLI prints while it's open, and stops when it closes", async () => {
    const app = fakeInstance();
    render.mockReturnValue(app);
    const running = startRepl(options);
    await vi.waitFor(() => expect(render).toHaveBeenCalled());
    const repl = { registry: new Registry(false), failures: () => [], close: vi.fn(() => []), labelPost: vi.fn(() => "#7"), isVerbose: () => false };
    render.mock.calls[0][0].props.onReady(repl);
    const [labeler] = setPostLabeler.mock.lastCall!;
    expect(labeler({ uri: "at://x", cid: "bafy" })).toBe("#7");
    app.unmount();
    await running;
    expect(setPostLabeler.mock.lastCall).toEqual([undefined]);
  });

  describe("after /switch", () => {
    const opened = async (settings = options.settings) => {
      const app = fakeInstance();
      render.mockReturnValue(app);
      const switchAccount = vi.fn(async () => ({ agent: { ...offlineProps.agent, selfDid: "did:plc:work" as const }, handle: "work.bsky.social" as never, profile: "work" }));
      const store = { save: vi.fn(async () => {}), lock: vi.fn(async () => true), unlock: vi.fn(async () => {}), delete: vi.fn(async () => {}), prune: vi.fn(async () => {}) };
      const session = { store, id: "k3f7xq", createdAt: "2026-11-04T09:00:00.000Z", did: "did:plc:me", keep: 7 } as never;
      const running = startRepl({ ...options, settings, profile: "me", switchAccount, session });
      await vi.waitFor(() => expect(render).toHaveBeenCalled());
      const { props } = render.mock.calls[0][0];
      await props.switchAccount("work");
      return { app, running, props };
    };
    it("drafts and scheduled posts follow the account", async () => {
      const { app, running, props } = await opened();
      const draft = { reason: "manual", type: "post", text: "hi" };
      await props.drafts.save(draft);
      await props.listDrafts();
      await props.saveScheduled({ scheduledAt: "2099-01-01T00:00:00.000Z", text: "later" });
      expect(saveDraft).toHaveBeenCalledWith(draft, "work");
      expect(readDrafts).toHaveBeenCalledWith("work");
      expect(saveScheduledPost).toHaveBeenCalledWith(expect.anything(), "work");
      app.unmount();
      await running;
    });
    it("the session is saved as the new account", async () => {
      const setAccount = vi.spyOn(SessionKeeper.prototype, "setAccount");
      const { app, running } = await opened();
      expect(setAccount).toHaveBeenCalledWith({ handle: "work.bsky.social", did: "did:plc:work", profile: "work" });
      setAccount.mockRestore();
      app.unmount();
      await running;
    });
    it("the summary follows /settings verbose", async () => {
      const { app, running, props } = await opened();
      const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      props.onReady({ registry: new Registry(false), failures: () => [], close: vi.fn(() => []), settled: vi.fn(async () => {}), snapshot: vi.fn(() => ({ posts: [], staged: [], pending: [], composer: { text: "", cursor: 0 } })), isVerbose: () => true });
      app.unmount();
      await running;
      const printed = write.mock.calls.map(([chunk]) => String(chunk)).join("");
      write.mockRestore();
      expect(printed).toContain("as @me.bsky.social");
    });
    it("the verbose summary names both accounts", async () => {
      const { app, running, props } = await opened({ ...options.settings, verbose: true });
      const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      props.onReady({ registry: new Registry(false), failures: () => [], close: vi.fn(() => []), settled: vi.fn(async () => {}), snapshot: vi.fn(() => ({ posts: [], staged: [], pending: [], composer: { text: "", cursor: 0 } })), isVerbose: () => true });
      app.unmount();
      await running;
      const printed = write.mock.calls.map(([chunk]) => String(chunk)).join("");
      write.mockRestore();
      expect(printed).toContain("as @me.bsky.social, @work.bsky.social");
    });
  });

  it("hands the App the flags a resume ignored", async () => {
    const app = fakeInstance();
    render.mockReturnValue(app);
    const session = { store: {}, id: "k3f7xq", createdAt: "2026-11-04T09:00:00.000Z", did: "did:plc:me", keep: 7, ignoredFlags: ["--undo 10: /settings undo 10"] } as never;
    const running = startRepl({ ...options, session });
    await vi.waitFor(() => expect(render).toHaveBeenCalled());
    expect(render.mock.calls[0][0].props.ignoredFlags).toEqual(["--undo 10: /settings undo 10"]);
    app.unmount();
    await running;
  });

  it("doesn't count a scheduler that sends another profile's posts", async () => {
    const app = fakeInstance();
    render.mockReturnValue(app);
    const running = startRepl({ ...options, profile: "work" });
    await vi.waitFor(() => expect(render).toHaveBeenCalled());
    const { schedulerRunning } = render.mock.calls[0][0].props;
    getSchedulerStatus.mockReturnValue("enabled");
    schedulerProfile.mockReturnValueOnce(undefined);
    expect(schedulerRunning()).toBe(false);
    schedulerProfile.mockReturnValueOnce("work");
    expect(schedulerRunning()).toBe(true);
    getSchedulerStatus.mockReset();
    app.unmount();
    await running;
  });

  it("treats a scheduler it can't check as not running", async () => {
    const app = fakeInstance();
    render.mockReturnValue(app);
    const running = startRepl(options);
    await vi.waitFor(() => expect(render).toHaveBeenCalled());
    const { schedulerRunning } = render.mock.calls[0][0].props;
    getSchedulerStatus.mockReturnValueOnce("enabled");
    expect(schedulerRunning()).toBe(true);
    getSchedulerStatus.mockReturnValueOnce("not installed");
    expect(schedulerRunning()).toBe(false);
    getSchedulerStatus.mockImplementationOnce(() => {
      throw new Error("Unsupported platform");
    });
    expect(schedulerRunning()).toBe(false);
    app.unmount();
    await running;
  });

  it("unmounts Ink on an uncaught error so the terminal is restored, then rethrows it", async () => {
    const app = fakeInstance();
    render.mockReturnValue(app);
    const before = process.listeners("uncaughtException");
    const running = startRepl(options);
    await vi.waitFor(() => expect(render).toHaveBeenCalled());

    const [crash] = added("uncaughtException", before);
    const boom = new Error("boom");
    crash(boom);

    expect(app.unmount).toHaveBeenCalled();
    await expect(running).rejects.toThrow("boom");
    expect(added("uncaughtException", before)).toHaveLength(0);
  });
  it("says so and exits 1 when Ink stops without the user leaving", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const app = fakeInstance();
    render.mockReturnValue(app);
    const running = startRepl(options);
    await vi.waitFor(() => expect(render).toHaveBeenCalled());
    app.unmount();
    await running;
    expect(write).toHaveBeenCalledWith("bsky repl stopped because its input closed.\n");
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    write.mockRestore();
  });
  it("exits quietly when the user leaves", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const app = fakeInstance();
    render.mockReturnValue(app);
    const running = startRepl(options);
    await vi.waitFor(() => expect(render).toHaveBeenCalled());
    app.exit(LEFT);
    await running;
    expect(write).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    write.mockRestore();
  });
  describe("with a saved session", () => {
    const store = () => ({
      save: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      lock: vi.fn(async () => true),
      unlock: vi.fn(async () => {}),
      prune: vi.fn(async () => {}),
    });
    const fileOf = (o: object = {}) => ({ posts: [{}], staged: [], pending: [], composer: { text: "", cursor: 0 }, ...o });
    const fakeRepl = (verbose = false) => ({ registry: new Registry(false), failures: () => [], isVerbose: () => verbose, close: vi.fn(() => []), settled: vi.fn(async () => {}), snapshot: vi.fn(() => fileOf()) });
    const start = async (session: object, settings = options.settings) => {
      const app = fakeInstance();
      render.mockReturnValue(app);
      const running = startRepl({ ...options, settings, profile: "work", session: { id: "k3f7xq", createdAt: "2026-11-04T09:00:00.000Z", did: "did:plc:me", keep: 7, ...session } as never });
      await vi.waitFor(() => expect(render).toHaveBeenCalled());
      const { props } = render.mock.calls[0][0];
      const repl = fakeRepl(settings.verbose);
      props.onReady(repl);
      return { app, running, props, repl };
    };
    it("gives the session's details to what saves it", async () => {
      const s = store();
      const { app, running, props, repl } = await start({ store: s });
      await props.keeper.save(repl);
      expect(repl.snapshot).toHaveBeenCalledWith(
        { id: "k3f7xq", createdAt: "2026-11-04T09:00:00.000Z", handle: "me.bsky.social", did: "did:plc:me", profile: "work" },
        { text: "", cursor: 0 },
        [],
      );
      app.exit(LEFT);
      await running;
      expect(s.prune).toHaveBeenCalledWith(7);
    });
    it("says how to resume, once it's safely saved", async () => {
      const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const { app, running } = await start({ store: store() });
      app.exit(LEFT);
      await running;
      expect(write).toHaveBeenCalledWith(expect.stringContaining("resume: bsky -r k3f7xq"));
      write.mockRestore();
    });
    it("says why it couldn't save, and offers no hint", async () => {
      const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const s = store();
      s.save.mockRejectedValue(new Error("ENOSPC"));
      const { app, running } = await start({ store: s });
      app.exit(LEFT);
      await running;
      expect(err).toHaveBeenCalledWith("Couldn't save this session (ENOSPC)\n");
      expect(out).not.toHaveBeenCalledWith(expect.stringContaining("resume:"));
      out.mockRestore();
    });
    it("ends the session on a crash, and keeps listening for errors until it has", async () => {
      const s = store();
      let finish = () => {};
      s.save.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
      const before = process.listeners("uncaughtException");
      const { running } = await start({ store: s });
      added("uncaughtException", before)[0](new Error("boom"));
      await vi.waitFor(() => expect(s.save).toHaveBeenCalled());
      expect(added("uncaughtException", before)).toHaveLength(1);
      finish();
      await expect(running).rejects.toThrow("boom");
      expect(s.unlock).toHaveBeenCalled();
      expect(added("uncaughtException", before)).toHaveLength(0);
    });
    it("counts a resumed session's time from when it began", async () => {
      const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const resume = { composer: { text: "", cursor: 0 }, history: [] };
      const { app, running } = await start({ store: store(), resume }, { ...options.settings, verbose: true });
      app.exit(LEFT);
      await running;
      expect(out).toHaveBeenCalledWith(expect.stringContaining("Session 2026-11-04T09:00:00.000Z"));
      out.mockRestore();
    });
  });

  it("prints the exit summary once Ink has exited", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const app = fakeInstance();
    render.mockReturnValue(app);
    const running = startRepl(options);
    await vi.waitFor(() => expect(render).toHaveBeenCalled());
    const [element] = render.mock.calls[0];
    element.props.onReady({ registry: new Registry(false), failures: () => [], isVerbose: () => false, close: () => [], settled: async () => {} });
    app.exit(LEFT);
    await running;
    expect(write).toHaveBeenCalledWith("No posts this session\n");
    write.mockRestore();
  });
});
