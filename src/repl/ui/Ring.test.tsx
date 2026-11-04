import { stripVTControlCharacters } from "node:util";
import type { ReactNode } from "react";
import { describe, it, expect } from "vitest";
import { renderToString } from "ink";
import { Ring, ringColor, ringCount, ringGlyph } from "./Ring";

// Colour codes depend on the terminal running the tests.
const plain = (node: ReactNode) => stripVTControlCharacters(renderToString(node));

describe("ring", () => {
  it.each([[0, "○"], [59, "○"], [60, "◔"], [149, "◔"], [150, "◑"], [224, "◑"], [225, "◕"], [299, "◕"], [300, "●"], [342, "●"]])(
    "%i → %s", (n, glyph) => expect(ringGlyph(n, 300)).toBe(glyph),
  );
  it("colours by count", () => {
    expect([259, 260, 300, 301].map((n) => ringColor(n, 300))).toEqual(["green", "yellow", "yellow", "red"]);
  });
  it("shows the overflow", () => {
    expect(ringCount(148, 300)).toBe("148/300");
    expect(ringCount(342, 300)).toBe("342/300 (−42)");
  });
  it("renders the segment status line", () => {
    const seg = { index: 2, total: 3, text: "x".repeat(148), region: "send" as const };
    expect(plain(<Ring segment={seg} />)).toContain("segment 2/3  ◔ 148/300");
    expect(plain(<Ring segment={{ ...seg, total: 1, index: 1 }} />)).not.toContain("segment");
    expect(plain(<Ring segment={{ ...seg, region: "kept" }} />)).toContain("kept");
  });
});
