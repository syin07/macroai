import { formatInTimeZone } from "date-fns-tz";
import type { MealListItem } from "@/types/api";

/** Cursors may overlap after edits; render each saved record once, newest first. */
export function groupMeals(meals: MealListItem[], timezone: string) {
  const unique = [...new Map(meals.map((meal) => [meal.id, meal])).values()];
  unique.sort(
    (a, b) =>
      Date.parse(b.consumed_at) - Date.parse(a.consumed_at) ||
      b.id.localeCompare(a.id),
  );
  const days = new Map<string, MealListItem[]>();
  for (const meal of unique) {
    const date = formatInTimeZone(meal.consumed_at, timezone, "yyyy-MM-dd");
    const day = days.get(date) ?? [];
    day.push(meal);
    days.set(date, day);
  }
  return [...days].map(([date, meals]) => ({ date, meals }));
}
