import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { isoDateTime } from "@/lib/validation/common";

// consumed_at is decided in code, not by the model (PRD FR-09): the user's own time words are parsed
// in their time zone; the model's ISO guess is the fallback for phrasings we don't parse; the default
// is now. Pure: `now` and the zone are always passed in.
//
// Rules for the ambiguous cases (each one has a test in dates.test.ts and a case in
// tests/eval/date-cases.jsonl):
//
// - Never in the future. People log what they already ate. A time up to EARLY_LOGGING_GRACE ahead is
//   someone logging a little early, so we use now. Anything further ahead moves to the most recent
//   past occurrence, or is clamped to now when the user pinned the day ("today at 8pm" at 9 AM).
// - "at 8 PM" with no day: today if 8 PM has passed (or is within the grace), otherwise yesterday.
// - A bare hour ("at 8", "around 6") with no day and no part of day: the most recent past 8:00,
//   AM or PM, today or yesterday. With a day named ("yesterday at 6"), 1-6 means PM and 7-12 means AM.
// - A day with no time ("yesterday", "3 days ago", "last Tuesday"): the same local clock time as now,
//   on that day. We keep the wall clock rather than subtracting 24 h, so a DST change can't shift the hour.
// - "last <weekday>": the most recent past one, 1 to 7 days back. On a Tuesday, "last Tuesday" is a week
//   ago, and on a Wednesday it is yesterday (not the Tuesday of the week before: for past-tense
//   logging the nearest one is the likely meaning, and the card's time is editable). A bare or "on"
//   weekday ("tuesday", "on tue") may be today.
//   If that puts the time in the future ("tuesday at 8pm" at 10 AM on a Tuesday), it means a week ago.
// - "last night" means 8 PM yesterday. "last night at 1am" (or at midnight) means the early hours
//   of today, or of yesterday if that time hasn't come yet today.
// - Just after midnight: "yesterday" is still the calendar day before. Before NIGHT_OWL_END_HOUR,
//   "this morning", "this evening", and "tonight" refer to the day that just ended, if the time named
//   hasn't happened yet today. People up at 12:30 AM still call the evening they're in "tonight".
// - "two hours ago" subtracts elapsed time, so it stays correct across a DST change.
// - DST gaps and overlaps: a wall-clock time that doesn't exist (2:30 AM on spring-forward day) moves
//   forward by the gap (3:30 AM), and one that happens twice (1:30 AM on fall-back day) takes the
//   first occurrence. Temporal's "compatible" mode does the same.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// A time up to this far ahead is someone logging slightly early: use now.
const EARLY_LOGGING_GRACE = 2 * HOUR;
// Model timestamps older than this are more likely a mistake than a real back-dated meal.
const MAX_MODEL_AGE = 30 * DAY;
// Before this local hour, "tonight", "this evening", and "this morning" can mean the day that just ended.
const NIGHT_OWL_END_HOUR = 4;
// "last night at <hour>" with an hour before this is the early hours of today.
const SMALL_HOURS_END = 5;

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, couple: 2, few: 3,
};

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const WEEKDAY_ABBREVIATIONS: Record<string, number> = {
  mon: 0, tue: 1, tues: 1, wed: 2, thu: 3, thur: 3, thurs: 3, fri: 4, sat: 5, sun: 6,
};

type PartKind = "morning" | "midday" | "afternoon" | "evening" | "night";

// Part-of-day words → local clock time [hour, minute]; later entries win ("late night" over "night").
const PARTS_OF_DAY: Array<[RegExp, [number, number], PartKind]> = [
  [/\b(breakfast|morning)\b/, [8, 0], "morning"],
  [/\bbrunch\b/, [10, 30], "morning"],
  [/\b(lunch|lunchtime)\b/, [12, 30], "midday"],
  [/\b(noon|midday)\b/, [12, 0], "midday"],
  [/\bafternoon\b/, [15, 0], "afternoon"],
  [/\b(dinner|supper|evening)\b/, [19, 0], "evening"],
  [/\b(night|tonight)\b/, [20, 0], "night"],
  [/\blate (at |last )?night\b/, [23, 0], "night"],
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

function localClock(now: Date, timezone: string): [number, number] {
  const [hour, minute] = formatInTimeZone(now, timezone, "HH:mm").split(":").map(Number);
  return [hour!, minute!];
}

function addDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

// Wall-clock time in the user's zone → instant. If the time falls in a DST gap, date-fns-tz moves it
// back by the gap; we move it forward instead (see the rules above). In an overlap, date-fns-tz
// already picks the first occurrence.
function atLocalTime(date: LocalDate, hour: number, minute: number, timezone: string): Date {
  const pad = (n: number) => String(n).padStart(2, "0");
  const wanted = `${date.year}-${pad(date.month)}-${pad(date.day)}T${pad(hour)}:${pad(minute)}:00`;
  const instant = fromZonedTime(wanted, timezone);
  const got = formatInTimeZone(instant, timezone, "yyyy-MM-dd'T'HH:mm:ss");
  if (got === wanted) return instant;
  const gap = Date.parse(`${wanted}Z`) - Date.parse(`${got}Z`);
  return new Date(instant.getTime() + gap);
}

function count(token: string): number | null {
  if (/^\d+(\.\d+)?$/.test(token)) return Number(token);
  return NUMBER_WORDS[token] ?? null;
}

// "two hours ago", "2h ago", "half an hour ago", "an hour and a half ago", "45 min ago", "3 days ago"
const NUMBER_WORD = Object.keys(NUMBER_WORDS).join("|");
const UNIT = String.raw`(?:minutes?|mins?|m|hours?|hrs?|h|days?|d)`;
const AGO = new RegExp(
  String.raw`\b(?:(?<half>half an? hour|an? half hour)|` +
    String.raw`(?:(?<digits>\d+(?:\.\d+)?)\s*|(?<word>${NUMBER_WORD})\s+)(?<half1>and a half\s+)?(?:of\s+)?(?<unit>${UNIT})(?<half2>\s+and a half)?)` +
    String.raw`\s+ago\b`,
);

function parseAgo(phrase: string): { ms: number } | { days: number } | null {
  const match = AGO.exec(phrase);
  if (!match?.groups) return null;
  const { half, digits, word, half1, half2, unit } = match.groups;
  if (half) return { ms: 30 * MINUTE };
  const base = count((digits ?? word)!);
  if (base === null) return null;
  const n = base + (half1 || half2 ? 0.5 : 0);
  if (unit!.startsWith("d")) return { days: Math.round(n) };
  return { ms: n * (unit!.startsWith("h") ? HOUR : MINUTE) };
}

// How the day was named decides what happens when the resolved time is still in the future.
type DayKind =
  | "named" //      yesterday, the day before yesterday, 3 days ago, last <weekday>: clamp to now
  | "today" //      today, tonight, this morning/afternoon/evening: clamp, or the day before just after midnight
  | "weekday" //    a bare weekday that is today: a week earlier
  | "last_night"; // last night: the early hours of today if the hour is small, else yesterday

interface DayRef {
  offset: number; // days relative to today in the user's zone
  kind: DayKind;
}

function weekdayIn(phrase: string): number | null {
  const full = WEEKDAYS.findIndex((name) => new RegExp(`\\b${name}\\b`).test(phrase));
  if (full !== -1) return full;
  // Abbreviations need a qualifier ("last tue", "on sat") or must open the phrase followed by nothing or
  // a time ("tue", "fri night", "sun at 8pm"), so "sat down" and "in the sun" don't count.
  const abbreviation =
    /\b(?:last|on|this|past)\s+(mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)\b/.exec(phrase) ??
    /^(mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)\.?(?=$|[,!?]|\s+(?:at|around|for|morning|afternoon|evening|night|breakfast|brunch|lunch|dinner|supper)\b)/.exec(
      phrase,
    );
  return abbreviation ? WEEKDAY_ABBREVIATIONS[abbreviation[1]!]! : null;
}

// "yesterday", "last night", "last tuesday", "this morning" → days relative to today, or null if no day is named.
function parseDay(phrase: string, now: Date, timezone: string): DayRef | null {
  if (/\bday before yesterday\b/.test(phrase)) return { offset: -2, kind: "named" };
  if (/\byesterday\b/.test(phrase)) return { offset: -1, kind: "named" };
  if (/\blast night\b/.test(phrase)) return { offset: -1, kind: "last_night" };
  if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(phrase)) return { offset: 0, kind: "today" };

  const weekday = weekdayIn(phrase);
  if (weekday === null) return null;
  const today = Number(formatInTimeZone(now, timezone, "i")) - 1; // 0 = Monday
  const back = (today - weekday + 7) % 7;
  if (back !== 0) return { offset: -back, kind: "named" };
  // "last tuesday" said on a Tuesday means a week ago; a bare "tuesday" means today.
  return /\b(last|past)\b/.test(phrase) ? { offset: -7, kind: "named" } : { offset: 0, kind: "weekday" };
}

interface Clock {
  hour: number;
  minute: number;
  ambiguous: boolean; // a bare 1-12 hour with no am/pm and no part of day
}

// "at 8 PM", "8:30am", "20:00", "at 7", "8 o'clock" → a clock time; part-of-day words disambiguate a bare hour.
const CLOCK = /\b(?:(at|around|about|by)\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|o'?clock)?(?=\s|$|[,.!?])/g;

function parseClock(phrase: string): Clock | null {
  if (/\bmidnight\b/.test(phrase)) return { hour: 0, minute: 0, ambiguous: false };
  for (const match of phrase.matchAll(CLOCK)) {
    const [, preposition, hourText, minuteText, suffix] = match;
    // A bare number ("2 eggs") is not a time: needs "at", minutes, am/pm, or o'clock.
    if (!preposition && !minuteText && !suffix) continue;

    let hour = Number(hourText);
    const minute = minuteText ? Number(minuteText) : 0;
    if (hour > 23 || minute > 59) continue;

    const meridiem = suffix && !suffix.startsWith("o") ? suffix : null;
    if (meridiem) {
      if (hour < 1 || hour > 12) continue;
      hour = (hour % 12) + (meridiem.startsWith("p") ? 12 : 0);
      return { hour, minute, ambiguous: false };
    }
    if (hour === 0 || hour > 12) return { hour, minute, ambiguous: false }; // 24-hour clock

    const part = partOfDay(phrase);
    if (!part) return { hour, minute, ambiguous: true };
    if (part.kind === "night") {
      // "last night at 11" → 11 PM, "last night at 1" → 1 AM, "at 12" at night → midnight.
      if (hour === 12) hour = 0;
      else if (hour >= SMALL_HOURS_END) hour += 12;
    } else if (part.kind !== "morning" && hour < 12) {
      hour += 12;
    }
    return { hour, minute, ambiguous: false };
  }
  return null;
}

function partOfDay(phrase: string): { time: [number, number]; kind: PartKind } | null {
  let found: { time: [number, number]; kind: PartKind } | null = null;
  for (const [pattern, time, kind] of PARTS_OF_DAY) if (pattern.test(phrase)) found = { time, kind };
  return found;
}

// The latest candidate at or before `limit`, or null.
function latestBefore(candidates: Date[], limit: number): Date | null {
  let best: Date | null = null;
  for (const candidate of candidates) {
    if (candidate.getTime() <= limit && (!best || candidate.getTime() > best.getTime())) best = candidate;
  }
  return best;
}

// The user's time words → an instant, or null if the phrase names no time we understand.
// The result is never later than `now`.
export function parseTimePhrase(phrase: string | null, now: Date, timezone: string): Date | null {
  const text = phrase?.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
  if (!text) return null;

  if (/\b(just now|right now|just)\b/.test(text) && !/\bjust (before|after)\b/.test(text)) return now;

  const ago = parseAgo(text);
  if (ago && "ms" in ago) return new Date(now.getTime() - ago.ms);

  const rest = ago ? text.replace(AGO, " ") : text;
  const day: DayRef | null = ago ? { offset: -ago.days, kind: "named" } : parseDay(rest, now, timezone);
  const parsedClock = parseClock(rest);
  const part = partOfDay(rest);
  const clock: Clock | null =
    parsedClock ?? (part ? { hour: part.time[0], minute: part.time[1], ambiguous: false } : null);
  if (day === null && clock === null) return null;

  const today = localDate(now, timezone);
  const at = (offset: number, hour: number, minute: number) => atLocalTime(addDays(today, offset), hour, minute, timezone);

  if (clock === null) {
    // A day without a time: now if it's today, else the same local clock time as now on that day.
    if (day!.offset === 0) return now;
    const [hour, minute] = localClock(now, timezone);
    return at(day!.offset, hour, minute);
  }

  const { minute } = clock;
  if (day === null) {
    // No day named: the most recent past occurrence, today or yesterday. A bare hour can be AM or PM;
    // a clear time may be a little ahead (early logging).
    const hours = clock.ambiguous ? [clock.hour % 12, (clock.hour % 12) + 12] : [clock.hour];
    const candidates = [0, -1].flatMap((offset) => hours.map((hour) => at(offset, hour, minute)));
    const grace = clock.ambiguous ? 0 : EARLY_LOGGING_GRACE;
    const best = latestBefore(candidates, now.getTime() + grace)!;
    return best.getTime() > now.getTime() ? now : best;
  }

  // A day was named. An ambiguous bare hour: 1-6 is more often dinner than 6 AM.
  const hour = clock.ambiguous && clock.hour <= 6 ? clock.hour + 12 : clock.hour;
  if (day.kind === "last_night" && hour < SMALL_HOURS_END) {
    // "last night at 1am" is the early hours of today, unless that hasn't happened yet (said at 00:10),
    // then it's the night before. "last night" is past tense, so no early-logging grace.
    const tonight = at(0, hour, minute);
    return tonight.getTime() <= now.getTime() ? tonight : at(-1, hour, minute);
  }
  const result = at(day.offset, hour, minute);
  if (result.getTime() <= now.getTime()) return result;
  if (result.getTime() - now.getTime() <= EARLY_LOGGING_GRACE) return now;

  switch (day.kind) {
    case "last_night": // 8 PM or later yesterday is always in the past
    case "named":
      return now;
    case "weekday":
      return at(-7, hour, minute);
    case "today":
      if (localClock(now, timezone)[0] < NIGHT_OWL_END_HOUR) return at(-1, hour, minute);
      return now;
  }
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
