import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_MARKERS } from "@/repl/core/markers";

const { render, detectKittyKeyboard } = vi.hoisted(() => ({ render: vi.fn(), detectKittyKeyboard: vi.fn() }));
vi.mock("ink", async (importOriginal) => ({ ...(await importOriginal<typeof import("ink")>()), render }));
vi.mock("@/repl/ui/terminal", () => ({ detectKittyKeyboard }));
const { startRepl } = await import("@/repl");

/** An Ink instance whose exit promise settles when unmounted. */
function fakeInstance() {
  let settle: (err?: Error) => void = () => {};
  const exited = new Promise<void>((resolve, reject) => {
    settle = (err) => (err ? reject(err) : resolve());
  });
  return { unmount: vi.fn((err?: Error) => settle(err)), waitUntilExit: () => exited };
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
    const running = startRepl({ markers: DEFAULT_MARKERS });
    await vi.waitFor(() => expect(render).toHaveBeenCalled());
    const [element, options] = render.mock.calls[0];
    expect(element.props).toMatchObject({ markers: DEFAULT_MARKERS, kittyHint: hint });
    expect(options).toMatchObject({ exitOnCtrlC: false, kittyKeyboard: { mode } });
    app.unmount();
    await running;
  });

  it("unmounts Ink on an uncaught error so the terminal is restored, then rethrows it", async () => {
    const app = fakeInstance();
    render.mockReturnValue(app);
    const before = process.listeners("uncaughtException");
    const running = startRepl({ markers: DEFAULT_MARKERS });
    await vi.waitFor(() => expect(render).toHaveBeenCalled());

    const [crash] = added("uncaughtException", before);
    const boom = new Error("boom");
    crash(boom);

    expect(app.unmount).toHaveBeenCalledWith(boom);
    await expect(running).rejects.toThrow("boom");
    expect(added("uncaughtException", before)).toHaveLength(0);
  });
});
