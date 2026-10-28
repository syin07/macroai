import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Macros, Meal, MealListItem } from "@/types/api";
import { aggregateDays, daysInRange, type MacroAggregate } from "@/lib/nutrition/aggregate";
import { sumMacros } from "@/lib/nutrition/calc";
import { isoDate, timezone as timezoneSchema } from "@/lib/validation/common";
import { todayIn } from "./daily";
import { DatabaseError } from "./errors";
import { addDays, localDate, startOfLocalDay } from "./local-day";
import { activeMealsBetween, findMeal, listMeals } from "./meals";
import { getUserTimezone } from "./profile";

// History queries for B8's `search_meal_history` chat tool (plan B11). Read-only, and built on B7's
// helpers: listMeals (the list_meals SQL function: active meals only, `q` on the trigram indexes) and
// activeMealsBetween (active meals in an instant range). pending_deletion meals are never included.
// Local days are in the user's time zone. Totals come from the saved meal totals; nothing is rounded.
// PRD §13: days with no saved meals are reported as missing, never as zero.

export const HISTORY_DEFAULT_LIMIT = 20;
export const HISTORY_MAX_LIMIT = 100; // list_meals returns at most 101 rows; listMeals asks for limit + 1
export const AGGREGATE_MAX_DAYS = 366;

// PostgREST caps a response at max_rows (supabase/config.toml: 1000). Aggregates read meals in windows
// small enough to stay under it, and refuse rather than undercount if a window ever reaches it.
const POSTGREST_MAX_ROWS = 1000;
const WINDOW_DAYS = 31;

export const searchMealHistoryOptionsSchema = z
  .object({
    from: isoDate.optional(), // local date, inclusive
    to: isoDate.optional(), // local date, inclusive
    q: z.string().trim().max(100).optional(),
    limit: z.number().int().min(1).max(HISTORY_MAX_LIMIT).optional(),
    aggregate: z.boolean().optional(),
    timezone: timezoneSchema.optional(), // defaults to the profile's zone
  })
  .refine((o) => !o.from || !o.to || o.from <= o.to, { message: "from must be on or before to", path: ["from"] })
  .refine((o) => !o.aggregate || o.from, { message: "from is required with aggregate", path: ["from"] });

export type SearchMealHistoryOptions = z.input<typeof searchMealHistoryOptionsSchema>;

export interface HistoryMeal extends MealListItem {
  local_date: string; // consumed_at's calendar date in the user's zone
}

export interface DayTotals {
  date: string;
  meal_count: number;
  totals: Macros;
}

export interface HistoryAggregate extends MacroAggregate {
  days: DayTotals[]; // recorded days only, oldest first; missing days are in missing_dates
  includes_today: boolean; // today's totals are partial
  to_clamped_to_today: boolean; // the requested `to` was in the future (or omitted)
}

export interface MealHistoryResult {
  timezone: string;
  today: string;
  from: string | null;
  to: string | null; // after clamping to today when aggregating
  q: string | null;
  meals: HistoryMeal[]; // newest first
  has_more: boolean; // more meals match than `limit`
  aggregate: HistoryAggregate | null; // set when options.aggregate; covers every active meal in range, ignoring q
}

export interface LastMealMatch {
  meal: Meal;
  local_date: string;
  days_ago: number; // whole calendar days before today in the user's zone
  matched_items: string[]; // item names containing q (empty when only the meal name matched)
}

// Same error type as a failed schema parse, so routes and tools report it as a validation_error.
const rangeError = (path: string, message: string) => new z.ZodError([{ code: "custom", path: [path], message, input: undefined }]);

const withLocalDate = (meal: MealListItem, timezone: string): HistoryMeal => ({
  ...meal,
  local_date: localDate(meal.consumed_at, timezone),
});

// Per-local-day totals for [from, to] (inclusive local dates): one entry per day that has at least one
// active meal, oldest first.
export async function dailyTotalsBetween(
  supabase: SupabaseClient,
  userId: string,
  from: string,
  to: string,
  timezone: string,
): Promise<DayTotals[]> {
  const windows: Array<{ start: string; end: string }> = [];
  for (let day = from; day <= to; day = addDays(day, WINDOW_DAYS)) {
    const last = addDays(day, WINDOW_DAYS - 1) < to ? addDays(day, WINDOW_DAYS - 1) : to;
    windows.push({ start: startOfLocalDay(day, timezone), end: startOfLocalDay(addDays(last, 1), timezone) });
  }
  const chunks = await Promise.all(windows.map((w) => activeMealsBetween(supabase, userId, w.start, w.end)));
  if (chunks.some((chunk) => chunk.length >= POSTGREST_MAX_ROWS)) throw new DatabaseError("meal history", "row_limit");

  const byDay = new Map<string, Macros[]>();
  for (const meal of chunks.flat()) {
    const date = localDate(meal.consumed_at, timezone);
    byDay.set(date, [...(byDay.get(date) ?? []), meal.totals]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, totals]) => ({ date, meal_count: totals.length, totals: sumMacros(totals) }));
}

// Meals in a local-date range and/or matching a food name, newest first. With `aggregate`, also the
// per-day totals and sum / average-per-recorded-day for [from, to]; `to` defaults to today and is
// clamped to today, so future days never count as missing.
export async function searchMealHistory(
  supabase: SupabaseClient,
  userId: string,
  options: SearchMealHistoryOptions = {},
  now: Date = new Date(),
): Promise<MealHistoryResult> {
  const opts = searchMealHistoryOptionsSchema.parse(options);
  const timezone = opts.timezone ?? (await getUserTimezone(supabase, userId));
  const today = todayIn(timezone, now);
  const q = opts.q ? opts.q : null;

  let to = opts.to ?? null;
  let clamped = false;
  if (opts.aggregate && (to === null || to > today)) {
    to = today;
    clamped = true;
  }
  const from = opts.from ?? null;
  if (opts.aggregate && from && to) {
    if (from > to) throw rangeError("from", "The range starts after today");
    if (daysInRange(from, to) > AGGREGATE_MAX_DAYS) {
      throw rangeError("to", `Aggregate ranges are limited to ${AGGREGATE_MAX_DAYS} days`);
    }
  }

  const limit = opts.limit ?? HISTORY_DEFAULT_LIMIT;
  const [page, days] = await Promise.all([
    listMeals(supabase, {
      from: from ? startOfLocalDay(from, timezone) : null,
      to: to ? startOfLocalDay(addDays(to, 1), timezone) : null,
      q,
      cursor: null,
      limit,
    }),
    opts.aggregate && from && to ? dailyTotalsBetween(supabase, userId, from, to, timezone) : null,
  ]);

  return {
    timezone,
    today,
    from,
    to,
    q,
    meals: page.meals.map((meal) => withLocalDate(meal, timezone)),
    has_more: page.next_cursor !== null,
    aggregate:
      days && from && to
        ? { ...aggregateDays(days, { from, to }), days, includes_today: to === today, to_clamped_to_today: clamped }
        : null,
  };
}

const lastMatchOptionsSchema = z.object({
  q: z.string().trim().min(1).max(100),
  before: isoDate.optional(), // inclusive local date; defaults to no bound
  timezone: timezoneSchema.optional(),
});

// "When did I last have salmon?": the most recent active meal whose name or any item name contains q
// (case-insensitive), with its items, or null if there is none.
export async function findLastMealMatching(
  supabase: SupabaseClient,
  userId: string,
  options: z.input<typeof lastMatchOptionsSchema>,
  now: Date = new Date(),
): Promise<LastMealMatch | null> {
  const opts = lastMatchOptionsSchema.parse(options);
  const timezone = opts.timezone ?? (await getUserTimezone(supabase, userId));
  const page = await listMeals(supabase, {
    from: null,
    to: opts.before ? startOfLocalDay(addDays(opts.before, 1), timezone) : null,
    q: opts.q,
    cursor: null,
    limit: 1,
  });
  const hit = page.meals[0];
  if (!hit) return null;
  const meal = await findMeal(supabase, userId, hit.id);
  if (!meal || meal.status !== "active") return null; // deleted between the two reads

  const needle = opts.q.toLowerCase();
  const date = localDate(meal.consumed_at, timezone);
  const today = todayIn(timezone, now);
  return {
    meal,
    local_date: date,
    days_ago: date <= today ? daysInRange(date, today) - 1 : -(daysInRange(today, date) - 1),
    matched_items: meal.items.filter((item) => item.food_name.toLowerCase().includes(needle)).map((item) => item.food_name),
  };
}
