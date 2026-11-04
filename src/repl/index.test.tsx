import { describe, it, expect } from "vitest";
import { renderToString } from "ink";
import { smokeFrame } from "@/repl";
import { App, HEADER, KITTY_HINT } from "@/repl/ui/App";
import { DEFAULT_MARKERS } from "@/repl/core/markers";

describe("App shell", () => {
  it("smokeFrame renders the header and prompt without a TTY", () => {
    const frame = smokeFrame();
    expect(frame).toContain(HEADER);
    expect(frame).toContain("bsky ›");
    expect(frame).not.toContain(KITTY_HINT);
  });
  it("shows the kitty hint when asked", () => {
    // renderToString wraps at 80 columns; the hint is longer.
    expect(renderToString(<App markers={DEFAULT_MARKERS} kittyHint />, { columns: 120 })).toContain(KITTY_HINT);
  });
});
