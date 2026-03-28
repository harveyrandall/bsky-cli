import { describe, it, expect } from "vitest";
import {
  buildRRule,
  nextOccurrence,
  parseRRuleFrequency,
  parseCount,
  formatFrequency,
} from "./recurrence";

describe("buildRRule", () => {
  it("builds hourly rule", () => {
    expect(buildRRule("hourly", 3)).toBe("FREQ=HOURLY;COUNT=3");
  });

  it("builds daily rule", () => {
    expect(buildRRule("daily", 5)).toBe("FREQ=DAILY;COUNT=5");
  });

  it("builds fortnightly rule with INTERVAL=2", () => {
    expect(buildRRule("fortnightly", 4)).toBe(
      "FREQ=WEEKLY;INTERVAL=2;COUNT=4",
    );
  });

  it("builds monthly rule", () => {
    expect(buildRRule("monthly", 12)).toBe("FREQ=MONTHLY;COUNT=12");
  });

  it("builds annually rule", () => {
    expect(buildRRule("annually", 2)).toBe("FREQ=YEARLY;COUNT=2");
  });

  it("builds infinite rule when count is omitted", () => {
    expect(buildRRule("daily")).toBe("FREQ=DAILY");
  });

  it("builds infinite fortnightly rule", () => {
    expect(buildRRule("fortnightly")).toBe("FREQ=WEEKLY;INTERVAL=2");
  });
});

describe("nextOccurrence", () => {
  it("advances daily by 1 day", () => {
    const start = new Date("2026-03-28T10:00:00Z");
    const next = nextOccurrence(start, "daily");
    expect(next).not.toBeNull();
    expect(next!.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("advances hourly by 1 hour", () => {
    const start = new Date("2026-03-28T10:00:00Z");
    const next = nextOccurrence(start, "hourly");
    expect(next).not.toBeNull();
    expect(next!.getTime() - start.getTime()).toBe(60 * 60 * 1000);
  });

  it("advances fortnightly by 14 days", () => {
    const start = new Date("2026-03-28T10:00:00Z");
    const next = nextOccurrence(start, "fortnightly");
    expect(next).not.toBeNull();
    expect(next!.getTime() - start.getTime()).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it("advances monthly", () => {
    const start = new Date("2026-01-15T10:00:00Z");
    const next = nextOccurrence(start, "monthly");
    expect(next).not.toBeNull();
    expect(next!.getUTCMonth()).toBe(1); // February
    expect(next!.getUTCDate()).toBe(15);
  });

  it("handles monthly on the 31st (skips short months per RFC 5545)", () => {
    const start = new Date("2026-01-31T10:00:00Z");
    const next = nextOccurrence(start, "monthly");
    expect(next).not.toBeNull();
    // RFC 5545: months without a 31st are skipped — jumps to March 31st
    expect(next!.getUTCMonth()).toBe(2); // March
    expect(next!.getUTCDate()).toBe(31);
  });

  it("advances annually by 1 year", () => {
    const start = new Date("2026-03-28T10:00:00Z");
    const next = nextOccurrence(start, "annually");
    expect(next).not.toBeNull();
    expect(next!.getUTCFullYear()).toBe(2027);
    expect(next!.getUTCMonth()).toBe(2); // March
    expect(next!.getUTCDate()).toBe(28);
  });
});

describe("parseRRuleFrequency", () => {
  it("parses hourly", () => {
    expect(parseRRuleFrequency("FREQ=HOURLY;COUNT=3")).toBe("hourly");
  });

  it("parses daily", () => {
    expect(parseRRuleFrequency("FREQ=DAILY;COUNT=5")).toBe("daily");
  });

  it("parses fortnightly (WEEKLY + INTERVAL=2)", () => {
    expect(parseRRuleFrequency("FREQ=WEEKLY;INTERVAL=2;COUNT=4")).toBe(
      "fortnightly",
    );
  });

  it("parses monthly", () => {
    expect(parseRRuleFrequency("FREQ=MONTHLY;COUNT=12")).toBe("monthly");
  });

  it("parses annually", () => {
    expect(parseRRuleFrequency("FREQ=YEARLY;COUNT=2")).toBe("annually");
  });

  it("parses infinite rules (no COUNT)", () => {
    expect(parseRRuleFrequency("FREQ=DAILY")).toBe("daily");
    expect(parseRRuleFrequency("FREQ=WEEKLY;INTERVAL=2")).toBe("fortnightly");
  });

  it("returns null for unknown rules", () => {
    expect(parseRRuleFrequency("FREQ=SECONDLY;COUNT=1")).toBeNull();
  });
});

describe("parseCount", () => {
  it("parses numeric strings", () => {
    expect(parseCount("3")).toBe(3);
    expect(parseCount("10")).toBe(10);
    expect(parseCount("100")).toBe(100);
  });

  it("parses word numbers", () => {
    expect(parseCount("once")).toBe(1);
    expect(parseCount("twice")).toBe(2);
    expect(parseCount("thrice")).toBe(3);
    expect(parseCount("five")).toBe(5);
    expect(parseCount("ten")).toBe(10);
  });

  it("parses with 'times' suffix", () => {
    expect(parseCount("3 times")).toBe(3);
    expect(parseCount("five times")).toBe(5);
    expect(parseCount("once time")).toBe(1);
  });

  it("handles whitespace", () => {
    expect(parseCount("  3  ")).toBe(3);
    expect(parseCount("  five times  ")).toBe(5);
  });

  it("is case insensitive", () => {
    expect(parseCount("TWICE")).toBe(2);
    expect(parseCount("Five Times")).toBe(5);
  });

  it("returns null for invalid input", () => {
    expect(parseCount("foo")).toBeNull();
    expect(parseCount("0")).toBeNull();
    expect(parseCount("-1")).toBeNull();
    expect(parseCount("")).toBeNull();
  });
});

describe("formatFrequency", () => {
  it("formats all frequencies", () => {
    expect(formatFrequency("hourly")).toBe("every hour");
    expect(formatFrequency("daily")).toBe("every day");
    expect(formatFrequency("fortnightly")).toBe("every 2 weeks");
    expect(formatFrequency("monthly")).toBe("every month");
    expect(formatFrequency("annually")).toBe("every year");
  });
});
