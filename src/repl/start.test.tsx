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
    const composer = { text: "hi", cursor: 2, history: ["/thread"], historyIndex: null, scratch: [] };
    const fileOf = (o: object = {}) => ({ id: "k3f7xq", posts: [], staged: [], pending: [], composer: { text: "", cursor: 0 }, ...o });
    const store = () => ({
      save: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      lock: vi.fn(async () => true),
      unlock: vi.fn(async () => {}),
      prune: vi.fn(async () => {}),
    });
    /** Starts the REPL and hands back what it gave the App. */
    const start = async (session: object, snapshot = vi.fn((_m: object, c: { text: string }) => fileOf({ composer: c }))) => {
      const app = fakeInstance();
      render.mockReturnValue(app);
      const running = startRepl({ ...options, session: { id: "k3f7xq", createdAt: "2026-11-04T09:00:00.000Z", did: "did:plc:me", keep: 50, saving: true, ...session } as never });
      await vi.waitFor(() => expect(render).toHaveBeenCalled());
      const { props } = render.mock.calls[0][0];
      const repl = { registry: new Registry(false), failures: () => [], close: vi.fn(() => []), snapshot };
      props.onReady(repl);
      return { app, running, props, repl, snapshot };
    };
    it("saves through the store, locking the session on the first save", async () => {
      const s = store();
      const { app, running, props, repl, snapshot } = await start({ store: s });
      await props.saveSession(repl, composer);
      await props.saveSession(repl, composer);
      expect(snapshot).toHaveBeenCalledWith(expect.objectContaining({ id: "k3f7xq", handle: "me.bsky.social" }), { text: "hi", cursor: 2 }, ["/thread"]);
      expect(s.save).toHaveBeenCalledTimes(2);
      expect(s.lock).toHaveBeenCalledOnce();
      app.exit(LEFT);
      await running;
    });
    it("doesn't save a session with nothing in it", async () => {
      const s = store();
      const { app, running, props, repl } = await start({ store: s });
      await props.saveSession(repl, { ...composer, text: " " });
      expect(s.save).not.toHaveBeenCalled();
      app.exit(LEFT);
      await running;
    });
    it("clears the composer from the file when you leave, having dealt with it, and prunes", async () => {
      const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const s = store();
      const snapshot = vi.fn((_m: object, c: { text: string }) => fileOf({ composer: c, posts: [{}] }));
      const { app, running, props, repl } = await start({ store: s, keep: 7 }, snapshot);
      await props.saveSession(repl, composer);
      app.exit(LEFT);
      await running;
      expect(snapshot).toHaveBeenLastCalledWith(expect.anything(), { text: "", cursor: 0 }, ["/thread"]);
      expect(s.unlock).toHaveBeenCalledWith("k3f7xq");
      expect(s.prune).toHaveBeenCalledWith(7);
      expect(write).toHaveBeenCalledWith(expect.stringContaining("resume: bsky -r k3f7xq"));
      write.mockRestore();
    });
    it("deletes a session with nothing to resume, and offers no hint", async () => {
      const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const s = store();
      const { app, running } = await start({ store: s });
      app.exit(LEFT);
      await running;
      expect(s.delete).toHaveBeenCalledWith("k3f7xq");
      expect(write).toHaveBeenCalledWith("No posts this session\n");
      write.mockRestore();
    });
    it("keeps what's unsent when the REPL stops without you leaving, saving before the queue closes", async () => {
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const s = store();
      const order: string[] = [];
      const snapshot = vi.fn((_m: object, c: { text: string }) => {
        order.push("snapshot");
        return fileOf({ composer: c, pending: [{}] });
      });
      const { app, running, props, repl } = await start({ store: s }, snapshot);
      repl.close.mockImplementation(() => {
        order.push("close");
        return [];
      });
      await props.saveSession(repl, composer);
      order.length = 0;
      app.unmount();
      await running;
      expect(order).toEqual(["snapshot", "close"]);
      expect(snapshot).toHaveBeenLastCalledWith(expect.anything(), { text: "hi", cursor: 2 }, ["/thread"]);
      expect(s.unlock).toHaveBeenCalled();
    });
    it("releases the lock if the REPL crashes", async () => {
      const s = store();
      const before = process.listeners("uncaughtException");
      const { running } = await start({ store: s });
      added("uncaughtException", before)[0](new Error("boom"));
      await expect(running).rejects.toThrow("boom");
      expect(s.unlock).toHaveBeenCalled();
    });
    it("saves nothing with -R, and offers no hint", async () => {
      const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const s = store();
      const { app, running, props } = await start({ store: s, saving: false });
      expect(props.saveSession).toBeUndefined();
      app.exit(LEFT);
      await running;
      expect(s.delete).not.toHaveBeenCalled();
      expect(s.save).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledWith("No posts this session\n");
      write.mockRestore();
    });
    it("hands the App a session to resume, and holds its lock from the start", async () => {
      const s = store();
      const resume = fileOf({ history: ["/thread"], composer: { text: "hi", cursor: 1 } });
      const { app, running, props, repl } = await start({ store: s, resume });
      expect(props.resume).toBe(resume);
      await props.saveSession(repl, composer);
      expect(s.lock).not.toHaveBeenCalled();
      app.exit(LEFT);
      await running;
    });
  });

  it("prints the exit summary once Ink has exited", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const app = fakeInstance();
    render.mockReturnValue(app);
    const running = startRepl(options);
    await vi.waitFor(() => expect(render).toHaveBeenCalled());
    const [element] = render.mock.calls[0];
    element.props.onReady({ registry: new Registry(false), failures: () => [], close: () => [] });
    app.exit(LEFT);
    await running;
    expect(write).toHaveBeenCalledWith("No posts this session\n");
    write.mockRestore();
  });
});
