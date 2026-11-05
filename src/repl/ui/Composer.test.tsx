import { describe, it, expect, vi } from "vitest";

// Colour on, so the cursor's inverse cell and the ring's colour show in frames.
vi.hoisted(() => {
  process.env.FORCE_COLOR = "1";
});
import { render } from "ink-testing-library";
import { Composer, type ComposerProps } from "./Composer";
import { DEFAULT_MARKERS } from "@/repl/core/markers";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
function setup(overrides: Partial<ComposerProps> = {}) {
  const props: ComposerProps = {
    markers: DEFAULT_MARKERS,
    prompt: "bsky ›",
    limit: 300,
    onSubmit: vi.fn(async () => "done" as const),
    onEscape: vi.fn(() => "unhandled" as const),
    onInterrupt: vi.fn((text: string) => (text ? ("clear" as const) : ("hint" as const))),
    onEof: vi.fn(),
    onEdit: vi.fn(async (text: string) => text),
    onPaste: vi.fn(() => false),
    onSendNow: vi.fn(),
    onEditor: vi.fn(),
    onHint: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
  const app = render(<Composer {...props} />);
  const type = async (...chunks: string[]) => {
    for (const chunk of chunks) { app.stdin.write(chunk); await tick(); }
  };
  return { ...app, props, type };
}

describe("Composer", () => {
  it("reports an error thrown while handling a key and keeps running", async () => {
    const { type, props, lastFrame } = setup({
      onHint: () => {
        throw new Error("boom");
      },
    });
    await type("\x03"); // Ctrl+C on an empty composer asks for a hint
    expect(props.onError).toHaveBeenCalledWith("boom");
    await type("a");
    expect(lastFrame()).toContain("bsky › a");
  });
  it("shows staged files above the draft, and leaves room for them", async () => {
    const app = setup({ chips: "📎 chart.png" });
    Object.defineProperty(app.stdout, "rows", { value: 6, configurable: true });
    app.stdout.emit("resize");
    await app.type(["a", "b", "c", "d", "e", "f"].join("\n"));
    await tick();
    const frame = app.lastFrame() ?? "";
    expect(frame.split("\n")[0]).toContain("📎 chart.png");
    expect(frame.split("\n").length).toBeLessThan(6);
  });
  it("says a file needs text when you press Enter on nothing", async () => {
    const { type, props } = setup({ chips: "📎 chart.png" });
    await type("\r");
    expect(props.onHint).toHaveBeenCalledWith("Type some text to go with it: posts need text");
    expect(props.onSubmit).not.toHaveBeenCalled();
  });
  it("offers a paste into an empty composer, and inserts it if it isn't taken", async () => {
    const { type, props, lastFrame } = setup();
    await type("\x1b[200~/a.png\x1b[201~");
    expect(props.onPaste).toHaveBeenCalledWith("/a.png");
    expect(lastFrame()).toContain("bsky › /a.png");
  });
  it("doesn't insert a paste that was taken", async () => {
    const { type, lastFrame } = setup({ onPaste: () => true });
    await type("\x1b[200~/a.png\x1b[201~");
    expect(lastFrame()).not.toContain("/a.png");
  });
  it("doesn't offer a paste into a composer with text in it", async () => {
    const { type, props } = setup();
    await type("see ", "\x1b[200~/a.png\x1b[201~");
    expect(props.onPaste).not.toHaveBeenCalled();
  });
  it("hands Ctrl+D to onEof with the text", async () => {
    const { type, props } = setup();
    await type("abc", "\x04");
    expect(props.onEof).toHaveBeenCalledWith("abc");
  });
  it("won't leave while a command is still running", async () => {
    let finish = (_: "done") => {};
    const { type, props } = setup({ onSubmit: () => new Promise((resolve) => (finish = resolve)) });
    await type("/reply 1", "\r", "\x04");
    expect(props.onEof).not.toHaveBeenCalled();
    expect(props.onHint).toHaveBeenCalledWith("Still working — wait for it to finish.");
    finish("done");
    await tick();
    await type("\x04");
    expect(props.onEof).toHaveBeenCalledOnce();
  });
  it("shows a pending post dimmed, ignores typing, and sends it now on Enter", async () => {
    const { type, props, lastFrame } = setup({ pending: "waiting post" });
    expect(lastFrame()).toContain("bsky › waiting post");
    await type("x", "\r");
    expect(lastFrame()).not.toContain("x");
    expect(props.onSendNow).toHaveBeenCalledOnce();
  });
  it("replaces the text when asked to restore it", async () => {
    const { rerender, props, lastFrame } = setup();
    rerender(<Composer {...props} restore={{ id: 1, text: "back again" }} />);
    await tick();
    expect(lastFrame()).toContain("bsky › back again");
  });
  it("adds restored text to what's there rather than overwriting it", async () => {
    const { type, rerender, props, lastFrame } = setup();
    await type("typed ");
    rerender(<Composer {...props} restore={{ id: 1, text: "came back" }} />);
    await tick();
    expect(lastFrame()).toContain("bsky › typed came back");
  });
  it("reports its text as it changes", async () => {
    const { type, props } = setup();
    await type("hi");
    expect(props.onEditor).toHaveBeenLastCalledWith(expect.objectContaining({ text: "hi", cursor: 2 }));
  });
  it("puts back what Esc returns", async () => {
    const { type, lastFrame } = setup({ onEscape: () => ({ restore: "cancelled post" }) });
    await type("\x1b");
    await tick();
    expect(lastFrame()).toContain("bsky › cancelled post");
  });
  it("uses the prompt it is given", () => {
    const { lastFrame } = setup({ prompt: "thread (4) ›" });
    expect(lastFrame()).toContain("thread (4) › ");
  });
  it("draws the cursor on the grapheme under it, or a space at the end", async () => {
    const { type, lastFrame } = setup();
    await type("abc");
    expect(lastFrame()).toContain("abc\x1b[7m \x1b[27m");
    await type("\x1b[D");
    expect(lastFrame()).toContain("ab\x1b[7mc\x1b[27m");
  });
  it("colours the ring by count", async () => {
    const { type, lastFrame } = setup();
    await type(`\x1b[200~${"a".repeat(270)}\x1b[201~`);
    expect(lastFrame()).toContain("\x1b[33m◕ 270/300");
  });
});
