import type { Frequency } from "rrule";
import rrulePkg from "rrule";
const { RRule } = rrulePkg;

export type RecurrenceFrequency =
  | "hourly"
  | "daily"
  | "fortnightly"
  | "monthly"
  | "annually";

const FREQ_MAP: Record<RecurrenceFrequency, string> = {
  hourly: "FREQ=HOURLY",
  daily: "FREQ=DAILY",
  fortnightly: "FREQ=WEEKLY;INTERVAL=2",
  monthly: "FREQ=MONTHLY",
  annually: "FREQ=YEARLY",
};

const RRULE_FREQ_MAP: Record<RecurrenceFrequency, Frequency> = {
  hourly: RRule.HOURLY,
  daily: RRule.DAILY,
  fortnightly: RRule.WEEKLY,
  monthly: RRule.MONTHLY,
  annually: RRule.YEARLY,
};

const DISPLAY_MAP: Record<RecurrenceFrequency, string> = {
  hourly: "every hour",
  daily: "every day",
  fortnightly: "every 2 weeks",
  monthly: "every month",
  annually: "every year",
};

export const VALID_FREQUENCIES: RecurrenceFrequency[] = [
  "hourly",
  "daily",
  "fortnightly",
  "monthly",
  "annually",
];

/**
 * Build an RFC 5545 RRULE string for the given frequency and optional count.
 * e.g. buildRRule("daily", 5) → "FREQ=DAILY;COUNT=5"
 *      buildRRule("daily")    → "FREQ=DAILY"  (infinite)
 */
export function buildRRule(
  frequency: RecurrenceFrequency,
  count?: number,
): string {
  const base = FREQ_MAP[frequency];
  return count != null ? `${base};COUNT=${count}` : base;
}

/**
 * Compute the next occurrence date after `current` for the given RRULE.
 * Returns null if the series is exhausted.
 */
export function nextOccurrence(
  current: Date,
  frequency: RecurrenceFrequency,
): Date | null {
  const rule = new RRule({
    freq: RRULE_FREQ_MAP[frequency],
    interval: frequency === "fortnightly" ? 2 : 1,
    dtstart: current,
    count: 2, // current + next
  });

  const dates = rule.all();
  // Return the second date (the one after current), or null
  return dates.length > 1 ? dates[1] : null;
}

/**
 * Extract the frequency keyword from an RRULE string.
 * e.g. "FREQ=WEEKLY;INTERVAL=2;COUNT=4" → "fortnightly"
 */
export function parseRRuleFrequency(
  rrule: string,
): RecurrenceFrequency | null {
  if (rrule.includes("FREQ=HOURLY")) return "hourly";
  if (rrule.includes("FREQ=DAILY")) return "daily";
  if (rrule.includes("FREQ=WEEKLY") && rrule.includes("INTERVAL=2"))
    return "fortnightly";
  if (rrule.includes("FREQ=MONTHLY")) return "monthly";
  if (rrule.includes("FREQ=YEARLY")) return "annually";
  return null;
}

/**
 * Parse a natural language count: "3", "three", "twice", "5 times" → number.
 * Returns null if the input cannot be parsed.
 */
export function parseCount(input: string): number | null {
  const WORD_MAP: Record<string, number> = {
    once: 1,
    one: 1,
    twice: 2,
    two: 2,
    thrice: 3,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };

  const cleaned = input.trim().toLowerCase().replace(/\s*times?\s*$/, "");
  const num = parseInt(cleaned, 10);
  if (!isNaN(num) && num > 0) return num;
  return WORD_MAP[cleaned] ?? null;
}

/**
 * Format a frequency for human display.
 * e.g. "fortnightly" → "every 2 weeks"
 */
export function formatFrequency(frequency: RecurrenceFrequency): string {
  return DISPLAY_MAP[frequency];
}
