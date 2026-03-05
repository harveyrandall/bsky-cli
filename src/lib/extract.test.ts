import { describe, it, expect } from "vitest";
import { extractLinks, extractMentions, extractTags } from "./extract";

describe("extractLinks", () => {
  it("extracts a single URL", () => {
    const result = extractLinks("check https://example.com out");
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("https://example.com");
  });

  it("extracts multiple URLs", () => {
    const result = extractLinks("see https://a.com and http://b.com");
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("https://a.com");
    expect(result[1].text).toBe("http://b.com");
  });

  it("returns empty for no URLs", () => {
    expect(extractLinks("no links here")).toHaveLength(0);
  });

  it("handles URLs with query params", () => {
    const result = extractLinks("https://example.com/path?q=1&b=2");
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("https://example.com/path?q=1&b=2");
  });

  it("computes correct byte offsets for ASCII", () => {
    const result = extractLinks("hi https://x.com");
    expect(result[0].start).toBe(3);
    expect(result[0].end).toBe(16);
  });

  it("computes correct byte offsets with multi-byte chars before URL", () => {
    const result = extractLinks("\u{1F600} https://x.com");
    expect(result[0].start).toBe(5); // 4 bytes emoji + 1 space
    expect(result[0].end).toBe(18); // 5 + 13
  });
});

describe("extractMentions", () => {
  it("extracts a mention and strips @", () => {
    const result = extractMentions("hello @alice.bsky.social");
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("alice.bsky.social");
  });

  it("extracts multiple mentions", () => {
    const result = extractMentions("@alice @bob");
    expect(result).toHaveLength(2);
  });

  it("returns empty for no mentions", () => {
    expect(extractMentions("no mentions")).toHaveLength(0);
  });
});

describe("extractTags", () => {
  it("extracts a tag and strips #", () => {
    const result = extractTags("hello #vibes");
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("vibes");
  });

  it("extracts multiple tags", () => {
    const result = extractTags("#hello #world");
    expect(result).toHaveLength(2);
  });

  it("does not extract # mid-word", () => {
    expect(extractTags("email#tag")).toHaveLength(0);
  });

  it("returns empty for no tags", () => {
    expect(extractTags("no tags")).toHaveLength(0);
  });
});
