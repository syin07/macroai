import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { isoDateTime } from "@/lib/validation/common";

// consumed_at is decided in code, not by the model (PRD FR-09): the user's own time words are parsed
// in their time zone; the model's ISO guess is the fallback for phrasings we don't parse; the default
// is now. Pure: `now` and the zone are always passed in.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// A time up to this far ahead is someone logging slightly early: use now. Further ahead with no day
// named ("at 8 PM" said at 9 AM) means the most recent past occurrence, i.e. yesterday.
const EARLY_LOGGING_GRACE = 2 * HOUR;
// Model timestamps older than this are more likely a mistake than a real back-dated meal.
const MAX_MODEL_AGE = 30 * DAY;

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, couple: 2, few: 3,
};

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

// Part-of-day words → local clock time [hour, minute]; later entries win ("late night" over "night").
const PARTS_OF_DAY: Array<[RegExp, [number, number], "am" | "pm"]> = [
  [/\b(breakfast|morning)\b/, [8, 0], "am"],
  [/\bbrunch\b/, [10, 30], "am"],
  [/\b(lunch|lunchtime)\b/, [12, 30], "pm"],
  [/\b(noon|midday)\b/, [12, 0], "pm"],
  [/\bafternoon\b/, [15, 0], "pm"],
  [/\b(dinner|supper|evening)\b/, [19, 0], "pm"],
  [/\b(night|tonight)\b/, [20, 0], "pm"],
  [/\blate (at )?night\b/, [23, 0], "pm"],
];

interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number;
}

function localDate(now: Date, timezone: string): LocalDate {
  const [year, month, day] = formatInTimeZone(now, timezone, "yyyy-MM-dd").split("-").map(Number);
  return { year: year!, month: month!, day: day! };
}

function addDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

// Wall-clock time in the user's zone → instant. date-fns-tz handles DST gaps and overlaps.
function atLocalTime(date: LocalDate, hour: number, minute: number, timezone: string): Date {
  const pad = (n: number) => String(n).padStart(2, "0");
  return fromZonedTime(`${date.year}-${pad(date.month)}-${pad(date.day)}T${pad(hour)}:${pad(minute)}:00`, timezone);
}

function count(token: string): number | null {
  if (/^\d+(\.\d+)?$/.test(token)) return Number(token);
  return NUMBER_WORDS[token] ?? null;
}

// "two hours ago", "half an hour ago", "45 min ago", "3 days ago"
const AGO = /\b(half an? hour|(\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple|few)\s+(?:of\s+)?(minutes?|mins?|hours?|hrs?|days?))\s+ago\b/;

function parseAgo(phrase: string): { ms: number } | { days: number } | null {
  const match = AGO.exec(phrase);
  if (!match) return null;
  if (match[1]!.startsWith("half")) return { ms: 30 * MINUTE };
  const n = count(match[2]!);
  if (n === null) return null;
  const unit = match[3]!;
  if (unit.startsWith("d")) return { days: Math.round(n) };
  return { ms: n * (unit.startsWith("h") ? HOUR : MINUTE) };
}

// "yesterday", "last night", "last tuesday", "this morning" → days relative to today, or null if no day is named.
function parseDayOffset(phrase: string, now: Date, timezone: string): number | null {
  if (/\bday before yesterday\b/.test(phrase)) return -2;
  if (/\byesterday\b/.test(phrase) || /\blast night\b/.test(phrase)) return -1;
  if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(phrase)) return 0;

  const weekday = WEEKDAYS.findIndex((name) => new RegExp(`\\b${name}\\b`).test(phrase));
  if (weekday === -1) return null;
  const today = Number(formatInTimeZone(now, timezone, "i")) - 1; // 0 = Monday
  const back = (today - weekday + 7) % 7;
  // "last tuesday" said on a Tuesday means a week ago; a bare "tuesday" means today.
  if (back === 0) return /\blast\b/.test(phrase) ? -7 : 0;
  return -back;
}

// "at 8 PM", "8:30am", "20:00", "at 7" → [hour, minute]; part-of-day words disambiguate a bare hour.
const CLOCK = /\b(?:(at|around|about)\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?=\s|$|[,.!?])/g;

function parseClock(phrase: string): [number, number] | null {
  if (/\bmidnight\b/.test(phrase)) return [0, 0];
  for (const match of phrase.matchAll(CLOCK)) {
    const [, preposition, hourText, minuteText, meridiem] = match;
    // A bare number ("2 eggs") is not a time: needs "at", minutes, or am/pm.
    if (!preposition && !minuteText && !meridiem) continue;

    let hour = Number(hourText);
    const minute = minuteText ? Number(minuteText) : 0;
    if (hour > 23 || minute > 59) continue;

    if (meridiem) {
      if (hour < 1 || hour > 12) continue;
      hour = (hour % 12) + (meridiem.startsWith("p") ? 12 : 0);
    } else if (hour >= 1 && hour <= 12) {
      const part = partOfDay(phrase);
      if (part?.[1] === "pm" && hour < 12) hour += 12;
      else if (!part && hour <= 6) hour += 12; // "at 6" is more often dinner than 6 AM
    }
    return [hour, minute];
  }
  return null;
}

function partOfDay(phrase: string): [[number, number], "am" | "pm"] | null {
  let found: [[number, number], "am" | "pm"] | null = null;
  for (const [pattern, time, meridiem] of PARTS_OF_DAY) if (pattern.test(phrase)) found = [time, meridiem];
  return found;
}

// The user's time words → an instant, or null if the phrase names no time we understand.
export function parseTimePhrase(phrase: string | null, now: Date, timezone: string): Date | null {
  const text = phrase?.toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return null;

  if (/\b(just now|right now|just)\b/.test(text) && !/\bjust (before|after)\b/.test(text)) return now;

  const ago = parseAgo(text);
  if (ago && "ms" in ago) return new Date(now.getTime() - ago.ms);

  const rest = ago ? text.replace(AGO, " ") : text;
  const dayOffset = ago ? -ago.days : parseDayOffset(rest, now, timezone);
  const clock = parseClock(rest) ?? partOfDay(rest)?.[0] ?? null;
  if (dayOffset === null && clock === null) return null;

  const today = localDate(now, timezone);
  if (clock === null) {
    // A day without a time: now if it's today, else the same clock time as now on that day.
    if (dayOffset === 0) return now;
    return new Date(now.getTime() + dayOffset! * DAY);
  }

  let result = atLocalTime(addDays(today, dayOffset ?? 0), clock[0], clock[1], timezone);
  if (result.getTime() > now.getTime()) {
    const ahead = result.getTime() - now.getTime();
    if (ahead <= EARLY_LOGGING_GRACE || dayOffset !== null) return now;
    result = atLocalTime(addDays(today, -1), clock[0], clock[1], timezone);
  }
  return result;
}

// ISO 8601 with the user's UTC offset, e.g. "2026-10-25T19:30:00-07:00".
export function inUserZone(date: Date, timezone: string): string {
  return formatInTimeZone(date, timezone, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

export interface ResolveConsumedAtInput {
  timePhrase: string | null;
  modelConsumedAt: string | null;
  now: Date;
  timezone: string; // IANA, already validated
}

// ISO 8601 with the user's UTC offset, never in the future.
export function resolveConsumedAt({ timePhrase, modelConsumedAt, now, timezone }: ResolveConsumedAtInput): string {
  const parsed = parseTimePhrase(timePhrase, now, timezone);
  if (parsed) return inUserZone(parsed, timezone);

  if (modelConsumedAt && isoDateTime.safeParse(modelConsumedAt).success) {
    const model = new Date(modelConsumedAt);
    const age = now.getTime() - model.getTime();
    if (age >= -EARLY_LOGGING_GRACE && age <= MAX_MODEL_AGE) return inUserZone(age < 0 ? now : model, timezone);
  }
  return inUserZone(now, timezone);
}
