import { describe, it, expect } from "vitest";
import { lexicons } from "@atproto/api";
import { maxImageBytes, maxImages, maxVideoBytes } from "@/lib/limits";

describe("media limits", () => {
  it("follow the lexicons", () => {
    const images = lexicons.getDef("app.bsky.embed.images") as unknown as { properties: { images: { maxLength: number } } };
    expect(maxImages()).toBe(images.properties.images.maxLength);
    expect(maxImages()).toBeGreaterThan(0);
    expect(maxImageBytes()).toBe(1_000_000);
    expect(maxVideoBytes()).toBe(100_000_000);
  });
});
