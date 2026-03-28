import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseDate, parseTime, resolveAmPm, toUtcIso, formatLocalDateTime } from "./date-prompt";

describe("parseDate", () => {
  let nowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Fix "current year" to 2026 for tests
    nowSpy = vi.spyOn(Date.prototype, "getFullYear").mockReturnValue(2026);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it("parses DD-MM-YYYY", () => {
    expect(parseDate("26-03-2026")).toEqual({ day: 26, month: 3, year: 2026 });
  });

  it("parses DD-MM and defaults year to current", () => {
    expect(parseDate("26-03")).toEqual({ day: 26, month: 3, year: 2026 });
  });

  it("handles missing leading zeros", () => {
    expect(parseDate("3-3")).toEqual({ day: 3, month: 3, year: 2026 });
  });

  it("handles spaces instead of dashes", () => {
    expect(parseDate("3 3")).toEqual({ day: 3, month: 3, year: 2026 });
    expect(parseDate("26 03 2026")).toEqual({ day: 26, month: 3, year: 2026 });
  });

  it("returns null for invalid day", () => {
    expect(parseDate("32-01")).toBeNull();
    expect(parseDate("0-01")).toBeNull();
  });

  it("returns null for invalid month", () => {
    expect(parseDate("01-13")).toBeNull();
    expect(parseDate("01-0")).toBeNull();
  });

  it("returns null for year in the past", () => {
    expect(parseDate("01-01-2020")).toBeNull();
  });

  it("returns null for non-numeric input", () => {
    expect(parseDate("abc")).toBeNull();
    expect(parseDate("")).toBeNull();
    expect(parseDate("12-ab")).toBeNull();
  });

  it("returns null for too many parts", () => {
    expect(parseDate("01-01-2026-99")).toBeNull();
  });
});

describe("parseTime", () => {
  it("parses 24-hour unambiguous time", () => {
    expect(parseTime("15:30")).toEqual({ hours: 15, minutes: 30, ambiguous: false });
    expect(parseTime("00:30")).toEqual({ hours: 0, minutes: 30, ambiguous: false });
    expect(parseTime("13:00")).toEqual({ hours: 13, minutes: 0, ambiguous: false });
    expect(parseTime("23:59")).toEqual({ hours: 23, minutes: 59, ambiguous: false });
  });

  it("flags ambiguous times (1-12)", () => {
    expect(parseTime("3:15")).toEqual({ hours: 3, minutes: 15, ambiguous: true });
    expect(parseTime("03:15")).toEqual({ hours: 3, minutes: 15, ambiguous: true });
    expect(parseTime("12:00")).toEqual({ hours: 12, minutes: 0, ambiguous: true });
    expect(parseTime("1:00")).toEqual({ hours: 1, minutes: 0, ambiguous: true });
  });

  it("returns null for invalid input", () => {
    expect(parseTime("25:00")).toBeNull();
    expect(parseTime("12:60")).toBeNull();
    expect(parseTime("abc")).toBeNull();
    expect(parseTime("")).toBeNull();
    expect(parseTime("12")).toBeNull();
    expect(parseTime("12:30:00")).toBeNull();
  });
});

describe("resolveAmPm", () => {
  it("converts PM hours", () => {
    expect(resolveAmPm(3, "pm")).toBe(15);
    expect(resolveAmPm(12, "pm")).toBe(12);
    expect(resolveAmPm(1, "PM")).toBe(13);
  });

  it("converts AM hours", () => {
    expect(resolveAmPm(3, "am")).toBe(3);
    expect(resolveAmPm(12, "am")).toBe(0);
    expect(resolveAmPm(11, "AM")).toBe(11);
  });
});

describe("toUtcIso", () => {
  it("returns a valid ISO 8601 string", () => {
    const iso = toUtcIso(26, 3, 2026, 15, 30);
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // The local Date(2026, 2, 26, 15, 30) converted to UTC — exact value depends on TZ
    const date = new Date(iso);
    expect(date.getFullYear()).toBe(2026);
  });
});

describe("formatLocalDateTime", () => {
  it("formats a UTC ISO string as local date/time", () => {
    const formatted = formatLocalDateTime("2026-03-26T15:30:00.000Z");
    // Should contain day, month abbreviation, year, and time
    expect(formatted).toMatch(/\d{1,2}\s\w{3}\s\d{4}/); // e.g. "26 Mar 2026"
    expect(formatted).toMatch(/\d{2}:\d{2}/); // e.g. "15:30"
  });
});
