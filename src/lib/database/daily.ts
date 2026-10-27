import type { SupabaseClient } from "@supabase/supabase-js";
import type { DailySummary, Macros } from "@/types/api";
import { remaining, sumMacros } from "@/lib/nutrition/calc";
import { getGoalsOn } from "./goals";
import { localDate, localDayBounds } from "./local-day";
import { activeMealsBetween } from "./meals";

// DailySummary builder shared by the meals routes, GET /api/nutrition/daily and B8's chat tools.
// The user's zone comes from getUserTimezone() in ./profile.
// Totals always come from saved records: the stored totals of the day's active meals. Values are not
// rounded; the UI rounds for display.

export function todayIn(timezone: string, now: Date = new Date()): string {
  return localDate(now, timezone);
}

// Targets in effect on a local date (latest row with effective_from <= date and effective_to, which is
// exclusive, still open), as plain Macros.
async function targetsOn(supabase: SupabaseClient, userId: string, date: string): Promise<Macros | null> {
  const goals = await getGoalsOn(supabase, userId, date);
  if (!goals) return null;
  return { calories: goals.calories, protein_g: goals.protein_g, carbs_g: goals.carbs_g, fat_g: goals.fat_g };
}

export async function buildDailySummary(
  supabase: SupabaseClient,
  userId: string,
  date: string,
  timezone: string,
): Promise<DailySummary> {
  const { start, end } = localDayBounds(date, timezone);
  const [meals, targets] = await Promise.all([
    activeMealsBetween(supabase, userId, start, end),
    targetsOn(supabase, userId, date),
  ]);
  const consumed = sumMacros(meals.map((meal) => meal.totals));
  return {
    date,
    timezone,
    consumed,
    targets,
    remaining: targets ? remaining(consumed, targets) : null,
    meals,
  };
}

// One summary per distinct local day, in the order the instants are given (e.g. old day, then new day).
export async function buildDailySummariesFor(
  supabase: SupabaseClient,
  userId: string,
  instants: readonly string[],
  timezone: string,
): Promise<DailySummary[]> {
  const dates = [...new Set(instants.map((instant) => localDate(instant, timezone)))];
  return Promise.all(dates.map((date) => buildDailySummary(supabase, userId, date, timezone)));
}
