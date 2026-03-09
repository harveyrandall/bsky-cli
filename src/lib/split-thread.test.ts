import { describe, it, expect } from "vitest";
import {
  graphemeLength,
  splitThread,
  isEdgeCaseLength,
  trimSuggestions,
} from "./split-thread";

describe("graphemeLength", () => {
  it("counts ASCII characters", () => {
    expect(graphemeLength("hello")).toBe(5);
  });

  it("counts emoji as single graphemes", () => {
    // Family emoji is 1 grapheme despite multiple code points
    expect(graphemeLength("👨‍👩‍👧‍👦")).toBe(1);
    expect(graphemeLength("🧵")).toBe(1);
  });

  it("counts CJK characters", () => {
    expect(graphemeLength("你好世界")).toBe(4);
  });

  it("counts combining characters as single graphemes", () => {
    // é as e + combining acute accent = 1 grapheme
    expect(graphemeLength("e\u0301")).toBe(1);
  });

  it("handles empty string", () => {
    expect(graphemeLength("")).toBe(0);
  });
});

describe("splitThread", () => {
  it("returns single post for text under 300 chars", () => {
    const text = "Short post.";
    const result = splitThread(text);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("Short post.");
    expect(result[0].index).toBe(0);
  });

  it("returns single post for exactly 300 chars", () => {
    const text = "A".repeat(300);
    const result = splitThread(text);
    expect(result).toHaveLength(1);
  });

  it("splits at sentence boundaries", () => {
    // Create text with clear sentence boundaries
    const s1 = "A".repeat(200) + "."; // 201 chars
    const s2 = " " + "B".repeat(150) + "."; // 152 chars
    const text = s1 + s2; // 353 chars total
    const result = splitThread(text);

    expect(result).toHaveLength(2);
    expect(result[0].text).toBe(s1);
    expect(result[1].text).toBe("B".repeat(150) + ".");
  });

  it("splits at clause boundaries when no sentence boundary available", () => {
    // One long "sentence" with a comma
    const before = "A".repeat(200) + ",";
    const after = " " + "B".repeat(150);
    const text = before + after;
    const result = splitThread(text);

    expect(result).toHaveLength(2);
    expect(result[0].text).toBe(before);
    expect(result[1].text).toBe("B".repeat(150));
  });

  it("splits at word boundaries as last resort", () => {
    // Words with spaces, no punctuation
    const words = [];
    let total = 0;
    while (total < 400) {
      const word = "word";
      words.push(word);
      total += word.length + 1; // +1 for space
    }
    const text = words.join(" ");
    const result = splitThread(text);

    expect(result.length).toBeGreaterThanOrEqual(2);
    // No post should exceed 300 chars
    for (const post of result) {
      expect(graphemeLength(post.text)).toBeLessThanOrEqual(300);
    }
  });

  it("never splits mid-word", () => {
    // Many short words
    const text = Array(80).fill("hello").join(" "); // 80 * 6 - 1 = 479 chars
    const result = splitThread(text);

    for (const post of result) {
      // No partial "hello" should appear
      const words = post.text.split(" ");
      for (const w of words) {
        expect(w).toBe("hello");
      }
    }
  });

  it("throws on a single word longer than maxChars", () => {
    const text = "A".repeat(301);
    expect(() => splitThread(text)).toThrow("Cannot split text");
  });

  it("ensures last post has >= 75 characters", () => {
    // Construct text that would naturally leave a short last post
    // Use word-separated text so redistribution can find split points
    const words1 = Array(50).fill("alpha").join(" "); // 299 chars
    const words2 = Array(50).fill("bravo").join(" "); // 299 chars
    const tail = " " + Array(5).fill("delta").join(" "); // 30 chars
    const text = words1 + ". " + words2 + "." + tail + ".";
    const result = splitThread(text);

    const lastPost = result[result.length - 1];
    expect(graphemeLength(lastPost.text)).toBeGreaterThanOrEqual(75);
  });

  it("handles text with emoji correctly", () => {
    // 🧵 is 1 grapheme. Build text with emoji.
    const text = "🧵 ".repeat(160); // 160 * 2 = 320 graphemes
    const result = splitThread(text);

    expect(result.length).toBeGreaterThanOrEqual(2);
    for (const post of result) {
      expect(graphemeLength(post.text)).toBeLessThanOrEqual(300);
    }
  });

  it("creates many posts for very long text", () => {
    // 10+ posts worth of text
    const sentences = Array(50)
      .fill(null)
      .map((_, i) => "This is sentence number " + (i + 1) + ".");
    const text = sentences.join(" ");
    const result = splitThread(text);

    expect(result.length).toBeGreaterThan(2);
    for (const post of result) {
      expect(graphemeLength(post.text)).toBeLessThanOrEqual(300);
    }
    // Indices should be sequential
    result.forEach((post, i) => expect(post.index).toBe(i));
  });
});

describe("splitThread with labels", () => {
  it("appends label by default", () => {
    const s1 = "A".repeat(250) + ".";
    const s2 = " " + "B".repeat(250) + ".";
    const text = s1 + s2;
    const result = splitThread(text, { threadLabel: true });

    expect(result).toHaveLength(2);
    expect(result[0].text).toContain("\n🧵 1/2");
    expect(result[1].text).toContain("\n🧵 2/2");
  });

  it("prepends label when configured", () => {
    const s1 = "A".repeat(250) + ".";
    const s2 = " " + "B".repeat(250) + ".";
    const text = s1 + s2;
    const result = splitThread(text, {
      threadLabel: true,
      threadLabelPosition: "prepend",
    });

    expect(result).toHaveLength(2);
    expect(result[0].text).toMatch(/^🧵 1\/2\n/);
    expect(result[1].text).toMatch(/^🧵 2\/2\n/);
  });

  it("accounts for label length in character budget", () => {
    const result = splitThread("A".repeat(250) + ". " + "B".repeat(250) + ".", {
      threadLabel: true,
    });

    for (const post of result) {
      expect(graphemeLength(post.text)).toBeLessThanOrEqual(300);
    }
  });

  it("stabilises when label digit count changes", () => {
    // Create text that might produce 9 or 10 posts depending on label overhead
    const sentences = Array(30)
      .fill(null)
      .map((_, i) => "Sentence " + (i + 1) + " here.");
    const text = sentences.join(" ");
    const result = splitThread(text, { threadLabel: true });

    // All posts should be within budget
    for (const post of result) {
      expect(graphemeLength(post.text)).toBeLessThanOrEqual(300);
    }
    // Labels should be consistent with actual count
    const total = result.length;
    result.forEach((post, i) => {
      expect(post.text).toContain(`🧵 ${i + 1}/${total}`);
    });
  });
});

describe("isEdgeCaseLength", () => {
  it("returns false for text <= 300", () => {
    expect(isEdgeCaseLength("A".repeat(300))).toBe(false);
  });

  it("returns true for text 301-375", () => {
    expect(isEdgeCaseLength("A".repeat(301))).toBe(true);
    expect(isEdgeCaseLength("A".repeat(375))).toBe(true);
  });

  it("returns false for text > 375", () => {
    expect(isEdgeCaseLength("A".repeat(376))).toBe(false);
  });

  it("trims whitespace before measuring", () => {
    expect(isEdgeCaseLength("  " + "A".repeat(300) + "  ")).toBe(false);
  });
});

describe("trimSuggestions", () => {
  it("returns empty for text within target", () => {
    expect(trimSuggestions("A".repeat(300))).toEqual([]);
  });

  it("finds sentence boundaries near target", () => {
    const text = "A".repeat(280) + ". " + "B".repeat(60) + ".";
    const suggestions = trimSuggestions(text);

    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].preview).toContain("...");
    expect(suggestions[0].charsToRemove).toBeGreaterThan(0);
  });

  it("returns at most 3 suggestions", () => {
    // Text with many clause boundaries
    const parts = [];
    for (let i = 0; i < 15; i++) {
      parts.push("A".repeat(20));
    }
    const text = parts.join(", ") + "B".repeat(50);
    const suggestions = trimSuggestions(text);

    expect(suggestions.length).toBeLessThanOrEqual(3);
  });
});
