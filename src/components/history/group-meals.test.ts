import { expect, it } from "vitest";
import type { MealListItem } from "@/types/api";
import { groupMeals } from "./group-meals";
const meal = (id: string, consumed_at: string): MealListItem => ({
  id,
  consumed_at,
  name: id,
  totals: { calories: 100, protein_g: 1, carbs_g: 2, fat_g: 3 },
});
it("groups by the account day across UTC midnight, deduplicates cursors, and sorts newest first", () => {
  const old = meal("old", "2026-10-26T06:00:00Z");
  const early = meal("early", "2026-10-26T23:00:00Z");
  const late = meal("late", "2026-10-27T01:00:00Z");
  expect(groupMeals([old, early, late, early], "America/Los_Angeles")).toEqual([
    { date: "2026-10-26", meals: [late, early] },
    { date: "2026-10-25", meals: [old] },
  ]);
});
it("keeps both instances of a repeated DST hour in chronological order", () => {
  const first = meal("first", "2026-11-01T08:30:00Z");
  const second = meal("second", "2026-11-01T09:30:00Z");
  expect(groupMeals([first, second], "America/Los_Angeles")).toEqual([
    { date: "2026-11-01", meals: [second, first] },
  ]);
});
