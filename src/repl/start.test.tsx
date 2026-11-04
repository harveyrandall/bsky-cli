import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_MARKERS } from "@/repl/core/markers";
import { LEFT } from "@/repl/ui/App";
import { Registry } from "@/repl/core/refs";

const { render, detectKittyKeyboard, saveDraft, deleteDraft, setConfigValues, getSchedulerStatus, saveScheduledPost } = vi.hoisted(() => ({
  saveScheduledPost: vi.fn(),
  getSchedulerStatus: vi.fn(),
  render: vi.fn(),
  detectKittyKeyboard: vi.fn(),
  saveDraft: vi.fn(),
  deleteDraft: vi.fn(),
  setConfigValues: vi.fn(),
}));
vi.mock("@/drafts", () => ({ saveDraft, deleteDraft }));
vi.mock("@/toml-config", () => ({ setConfigValues }));
vi.mock("@/lib/scheduler", () => ({ getSchedulerStatus }));
vi.mock("@/scheduled", () => ({ saveScheduledPost }));
vi.mock("ink", async (importOriginal) => ({ ...(await importOriginal<typeof import("ink")>()), render }));
vi.mock("@/repl/ui/terminal", () => ({ detectKittyKeyboard }));
const { startRepl, offlineProps } = await import("@/repl");
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
    const fakeRepl = () => ({ registry: new Registry(false), failures: () => [], close: vi.fn(() => []), settled: vi.fn(async () => {}), snapshot: vi.fn(() => fileOf()) });
    const start = async (session: object, settings = options.settings) => {
      const app = fakeInstance();
      render.mockReturnValue(app);
      const running = startRepl({ ...options, settings, profile: "work", session: { id: "k3f7xq", createdAt: "2026-11-04T09:00:00.000Z", did: "did:plc:me", keep: 7, ...session } as never });
      await vi.waitFor(() => expect(render).toHaveBeenCalled());
      const { props } = render.mock.calls[0][0];
      const repl = fakeRepl();
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
    element.props.onReady({ registry: new Registry(false), failures: () => [], close: () => [], settled: async () => {} });
    app.exit(LEFT);
    await running;
    expect(write).toHaveBeenCalledWith("No posts this session\n");
    write.mockRestore();
  });
});
