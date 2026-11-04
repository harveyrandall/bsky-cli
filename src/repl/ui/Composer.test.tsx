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
    onSubmit: vi.fn(async () => "done" as const),
    onHint: vi.fn(),
    onError: vi.fn(),
    onExit: vi.fn(),
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
  it("exits on Ctrl+D when the composer is empty", async () => {
    const { type, props } = setup();
    await type("\x04");
    expect(props.onExit).toHaveBeenCalledOnce();
  });
  it("asks for a second Ctrl+D before discarding a draft", async () => {
    const { type, props, lastFrame } = setup();
    await type("abc", "\x04");
    expect(props.onExit).not.toHaveBeenCalled();
    expect(props.onHint).toHaveBeenCalledWith(expect.stringContaining("Ctrl+D again"));
    expect(lastFrame()).toContain("bsky › abc");
    await type("\x04");
    expect(props.onExit).toHaveBeenCalledOnce();
  });
  it("forgets the first Ctrl+D once another key is pressed", async () => {
    const { type, props } = setup();
    await type("abc", "\x04", "d", "\x04");
    expect(props.onExit).not.toHaveBeenCalled();
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
