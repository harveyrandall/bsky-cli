import { describe, it, expect, vi } from "vitest";
import { lexicons } from "@atproto/api";
import { maxImageBytes, maxImages, maxVideoBytes } from "@/lib/limits";

describe("media limits", () => {
  it("rise when the lexicon does", () => {
    const getDef = vi.spyOn(lexicons, "getDef").mockReturnValue({
      properties: { images: { maxLength: 6 }, image: { maxSize: 2_000_000 }, video: { maxSize: 200_000_000 } },
    } as never);
    expect([maxImages(), maxImageBytes(), maxVideoBytes()]).toEqual([6, 2_000_000, 200_000_000]);
    getDef.mockRestore();
  });
  it("follow the lexicons", () => {
    const images = lexicons.getDef("app.bsky.embed.images") as unknown as { properties: { images: { maxLength: number } } };
    expect(maxImages()).toBe(images.properties.images.maxLength);
    expect(maxImages()).toBeGreaterThan(0);
    expect(maxImageBytes()).toBe(1_000_000);
    expect(maxVideoBytes()).toBe(100_000_000);
  });
});
