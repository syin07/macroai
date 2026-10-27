import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

// Pure helpers for "the user's local day". Dates are YYYY-MM-DD in an IANA zone; instants are ISO strings.

// The local calendar date of an instant.
export function localDate(instant: string | Date, timezone: string): string {
  return formatInTimeZone(typeof instant === "string" ? new Date(instant) : instant, timezone, "yyyy-MM-dd");
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

// Midnight at the start of a local date, as a UTC ISO instant. DST-safe (date-fns-tz).
export function startOfLocalDay(date: string, timezone: string): string {
  return fromZonedTime(`${date}T00:00:00`, timezone).toISOString();
}

// [start, end) of a local day. Not always 24 h: DST days are 23 or 25 h long.
export function localDayBounds(date: string, timezone: string): { start: string; end: string } {
  return { start: startOfLocalDay(date, timezone), end: startOfLocalDay(addDays(date, 1), timezone) };
}

// Instant bounds for an inclusive range of local dates (either end optional), as listMeals() takes
// them: `to` is inclusive, so its bound is the next local midnight.
export function localDateRange(
  from: string | null | undefined,
  to: string | null | undefined,
  timezone: string,
): { from: string | null; to: string | null } {
  return {
    from: from ? startOfLocalDay(from, timezone) : null,
    to: to ? startOfLocalDay(addDays(to, 1), timezone) : null,
  };
}
