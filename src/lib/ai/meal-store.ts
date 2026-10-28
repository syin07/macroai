import type { SupabaseClient } from "@supabase/supabase-js";
import type { Meal, MealSourceType } from "@/types/api";
import { ApiErrorException } from "@/lib/api-error";
import { buildDailySummary, todayIn } from "@/lib/database/daily";
import { DatabaseError } from "@/lib/database/errors";
import { findLastMealMatching, searchMealHistory } from "@/lib/database/history";
import { editMeal, prepareMeal } from "@/lib/database/meal-writes";
import { deleteMeal, findMeal, findMeals, listMeals, saveMeals } from "@/lib/database/meals";
import type { MealStore } from "./tools";

// The chat tools' view of B7's meal functions, bound to the session user. A thin adapter: the save and
// edit rules (server-side recalculation, version checks, user-edit marks) are the same functions the
// /api/meals routes use (database/meal-writes.ts), and totals come from database/daily.ts. Saves are
// idempotent on the proposal ID (the same key Ken's save button sends, so a chat save and a tap never
// duplicate).

// Proposal items have id: null; a saved item gets its id from the database.
function withoutId<T extends { id: unknown }>(item: T): Omit<T, "id"> {
  const copy: Partial<T> = { ...item };
  delete copy.id;
  return copy as Omit<T, "id">;
}

export function createMealStore(
  supabase: SupabaseClient,
  userId: string,
  timezone: string,
  now: () => Date = () => new Date(),
): MealStore {
  return {
    async saveProposal(proposal, sourceType: MealSourceType) {
      const prepared = prepareMeal({ ...proposal, source_type: sourceType, items: proposal.items.map(withoutId) });
      const { mealIds } = await saveMeals(supabase, proposal.proposal_id, [prepared]);
      const meal = mealIds[0] ? await findMeal(supabase, userId, mealIds[0]) : null;
      if (!meal) throw new DatabaseError("save_meals", "missing_after_write");
      return meal;
    },

    getMeal: (mealId) => findMeal(supabase, userId, mealId),

    async getMeals(mealIds) {
      const meals = await findMeals(supabase, userId, mealIds);
      return new Map(meals.map((meal): [string, Meal] => [meal.id, meal]));
    },

    updateMeal: async (mealId, patch) => (await editMeal(supabase, userId, mealId, patch)).meal,

    async deleteMeal(mealId) {
      const result = await deleteMeal(supabase, mealId);
      if (result.status === "not_found") throw new ApiErrorException("not_found");
      return { undo_until: new Date(result.undo_until).toISOString() };
    },

    dailySummary: (date) => buildDailySummary(supabase, userId, date ?? todayIn(timezone, now()), timezone),

    // The newest meals by consumed_at, with their items: what B10's context shows for corrections.
    async recentMeals(limit) {
      const page = await listMeals(supabase, { from: null, to: null, q: null, cursor: null, limit });
      return findMeals(supabase, userId, page.meals.map((meal) => meal.id));
    },

    // B11 history (database/history.ts). The zone and clock are the session's, passed in by the tool.
    searchHistory: (options, session) =>
      searchMealHistory(supabase, userId, { ...options, timezone: session.timezone }, session.now),

    lastMatching: (options, session) =>
      findLastMealMatching(supabase, userId, { ...options, timezone: session.timezone }, session.now),
  };
}
