import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_MARKERS } from "@/repl/core/markers";
import { LEFT } from "@/repl/ui/App";
import { Registry } from "@/repl/core/refs";

const { render, detectKittyKeyboard } = vi.hoisted(() => ({ render: vi.fn(), detectKittyKeyboard: vi.fn() }));
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
