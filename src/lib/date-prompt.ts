import type { Interface as ReadlineInterface } from "node:readline/promises";

/**
 * Parse a date string in DD-MM or DD-MM-YYYY format.
 * Accepts spaces instead of dashes and missing leading zeros.
 */
export function parseDate(input: string): { day: number; month: number; year: number } | null {
  const normalised = input.trim().replace(/\s+/g, "-");
  const parts = normalised.split("-");
  if (parts.length < 2 || parts.length > 3) return null;

  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const year = parts.length === 3 ? parseInt(parts[2], 10) : new Date().getFullYear();

  if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
  if (day < 1 || day > 31) return null;
  if (month < 1 || month > 12) return null;
  if (year < new Date().getFullYear()) return null;

  return { day, month, year };
}

/**
 * Parse a time string in HH:MM format.
 * Returns `ambiguous: true` when hours 1–12 (could be AM or PM).
 */
export function parseTime(input: string): { hours: number; minutes: number; ambiguous: boolean } | null {
  const trimmed = input.trim();
  const parts = trimmed.split(":");
  if (parts.length !== 2) return null;

  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);

  if (isNaN(hours) || isNaN(minutes)) return null;
  if (hours < 0 || hours > 23) return null;
  if (minutes < 0 || minutes > 59) return null;

  const ambiguous = hours >= 1 && hours <= 12;
  return { hours, minutes, ambiguous };
}

/**
 * Convert a 12-hour value to 24-hour.
 */
export function resolveAmPm(hours: number, ampm: string): number {
  const lower = ampm.toLowerCase().trim();
  if (lower === "am") return hours === 12 ? 0 : hours;
  if (lower === "pm") return hours === 12 ? 12 : hours + 12;
  return hours;
}

/**
 * Build a local Date from parts and return its ISO 8601 UTC string.
 */
export function toUtcIso(day: number, month: number, year: number, hours: number, minutes: number): string {
  const date = new Date(year, month - 1, day, hours, minutes, 0, 0);
  return date.toISOString();
}

const formatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * Format a UTC ISO string as a local date/time string.
 * e.g. "26 Mar 2026, 15:30"
 */
export function formatLocalDateTime(isoUtc: string): string {
  return formatter.format(new Date(isoUtc));
}

/**
 * Interactive date/time prompt loop.
 * Collects a DD-MM[-YYYY] date + HH:MM time, validates the date is in the future,
 * and asks the user to confirm. Returns an ISO 8601 UTC string.
 */
export async function promptDateTime(rl: ReadlineInterface): Promise<string> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // --- Date ---
    const dateInput = await rl.question("Date (DD-MM or DD-MM-YYYY, e.g. 26-03-2026): ");
    const parsed = parseDate(dateInput);
    if (!parsed) {
      console.error("Invalid date. Use DD-MM or DD-MM-YYYY format (e.g. 26-03 or 26-03-2026).");
      continue;
    }

    // --- Time ---
    const timeInput = await rl.question("Time (HH:MM, e.g. 15:30): ");
    const time = parseTime(timeInput);
    if (!time) {
      console.error("Invalid time. Use HH:MM format (e.g. 15:30 or 9:00).");
      continue;
    }

    let { hours } = time;
    const { minutes, ambiguous } = time;

    // --- AM/PM disambiguation ---
    if (ambiguous) {
      const ampm = await rl.question("AM or PM? ");
      const lower = ampm.toLowerCase().trim();
      if (lower !== "am" && lower !== "pm") {
        console.error("Please enter AM or PM.");
        continue;
      }
      hours = resolveAmPm(hours, lower);
    }

    // --- Build and validate ---
    const iso = toUtcIso(parsed.day, parsed.month, parsed.year, hours, minutes);
    const date = new Date(iso);

    if (date <= new Date()) {
      console.error("Date must be in the future.");
      continue;
    }

    // --- Confirm ---
    const display = formatLocalDateTime(iso);
    console.error(`Scheduled for: ${display}`);
    const confirm = await rl.question("Save the new scheduled date (Y/n) ");
    if (confirm.trim().toLowerCase() === "n") continue;

    return iso;
  }
}
