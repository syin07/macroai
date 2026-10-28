import type { Macros } from "@/types/api";
import { scaleMacros, sumMacros } from "./calc";

// Pure aggregation over a date range of per-day totals (no I/O). Used for history questions such as
// "average calories this week". PRD §13: a day with no saved meals is a missing record, not a day of
// zero food, so averages divide by recorded days only and the result says how many calendar days had
// no records. Values stay unrounded; round for display with round1Macros().

// A local calendar day (YYYY-MM-DD) that has at least one saved meal, and that day's summed totals.
export interface RecordedDayTotals {
  date: string;
  totals: Macros;
}

export interface MacroAggregate {
  from: string; // inclusive local date
  to: string; // inclusive local date
  days_in_range: number; // calendar days in [from, to]
  days_with_records: number;
  missing_dates: string[]; // calendar days in range with no records, oldest first
  sum: Macros;
  average_per_recorded_day: Macros | null; // null when no day in range has records (never a zero average)
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

// Days since the epoch for a valid YYYY-MM-DD, or a RangeError (rejects 2026-02-30 and friends).
function dayNumber(date: string): number {
  if (!DATE.test(date)) throw new RangeError(`Invalid date: ${date}`);
  const [year, month, day] = date.split("-").map(Number);
  const ms = Date.UTC(year!, month! - 1, day!);
  if (new Date(ms).toISOString().slice(0, 10) !== date) throw new RangeError(`Invalid date: ${date}`);
  return ms / DAY_MS;
}

const dateOf = (dayNum: number): string => new Date(dayNum * DAY_MS).toISOString().slice(0, 10);

// Number of calendar days in the inclusive range [from, to].
export function daysInRange(from: string, to: string): number {
  const span = dayNumber(to) - dayNumber(from);
  if (span < 0) throw new RangeError("`from` must not be after `to`");
  return span + 1;
}

// Days outside [from, to] are ignored. A date listed twice is a caller bug and throws, so a day can
// never be counted twice.
export function aggregateDays(days: readonly RecordedDayTotals[], range: { from: string; to: string }): MacroAggregate {
  const first = dayNumber(range.from);
  const total = daysInRange(range.from, range.to);
  const last = first + total - 1;

  const inRange = new Map<string, Macros>();
  for (const day of days) {
    const n = dayNumber(day.date);
    if (n < first || n > last) continue;
    if (inRange.has(day.date)) throw new RangeError(`Duplicate day: ${day.date}`);
    inRange.set(day.date, day.totals);
  }

  const missing: string[] = [];
  for (let n = first; n <= last; n++) {
    const date = dateOf(n);
    if (!inRange.has(date)) missing.push(date);
  }

  const recorded = inRange.size;
  const sum = sumMacros([...inRange.values()]);
  return {
    from: range.from,
    to: range.to,
    days_in_range: total,
    days_with_records: recorded,
    missing_dates: missing,
    sum,
    average_per_recorded_day: recorded > 0 ? scaleMacros(sum, 1 / recorded) : null,
  };
}
