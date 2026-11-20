import { describe, it, expect } from "vitest";
import { saidNo } from "./confirm";

describe("saidNo", () => {
  it.each(["n", "N", "no", "No", "NO", "  no ", "n\n"])("reads %j as no", (answer) => {
    expect(saidNo(answer)).toBe(true);
  });
  it.each(["", "  ", "y", "Y", "yes", " YES "])("reads %j as yes, the default", (answer) => {
    expect(saidNo(answer)).toBe(false);
  });
});
