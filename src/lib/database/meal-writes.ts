import type { SupabaseClient } from "@supabase/supabase-js";
import type { Meal, MealItem, SaveMealInput, UpdateMealRequest } from "@/types/api";
import { ApiErrorException } from "@/lib/api-error";
import { markUserEdits, OversizedItemError, recalculateMeal } from "@/lib/nutrition/recalc";
import { findMeal, updateMeal, type MealChanges, type PreparedMeal } from "./meals";

// The save and edit rules shared by /api/meals and B8's chat tools, so both paths store exactly the
// same thing: client (or model) macros and totals are never trusted and are recalculated server-side
// with the pure functions in src/lib/nutrition; edits check the meal version and mark what the user
// changed. Errors are ApiErrorExceptions the routes return as-is.

const tooLarge = (field: string) =>
  new ApiErrorException("validation_error", { fields: { [field]: "That amount is too large." } });

// One meal ready for saveMeals(). `fieldPrefix` places a too-large item in the request's field paths,
// e.g. "meals.0." for POST /api/meals.
export function prepareMeal(
  meal: Pick<SaveMealInput, "name" | "consumed_at" | "source_type"> & { items: ReadonlyArray<Omit<MealItem, "id">> },
  fieldPrefix = "",
): PreparedMeal {
  try {
    const { items, totals } = recalculateMeal(meal.items);
    return { name: meal.name, consumed_at: meal.consumed_at, source_type: meal.source_type, items, totals };
  } catch (error) {
    if (!(error instanceof OversizedItemError)) throw error;
    throw tooLarge(`${fieldPrefix}items.${error.index}.grams`);
  }
}

// PATCH semantics for one of the user's meals. Returns the meal before and after the change (both
// needed for the daily summaries when consumed_at moves across midnight). Throws not_found,
// version_conflict, or validation_error.
export async function editMeal(
  supabase: SupabaseClient,
  userId: string,
  mealId: string,
  body: UpdateMealRequest,
): Promise<{ before: Meal; meal: Meal }> {
  const before = await findMeal(supabase, userId, mealId);
  if (!before || before.status !== "active") throw new ApiErrorException("not_found");
  if (before.version !== body.version) throw new ApiErrorException("version_conflict");

  const changes: MealChanges = { version: body.version, name: body.name, consumed_at: body.consumed_at };
  if (body.items) {
    const known = new Set(before.items.map((item) => item.id));
    const seen = new Set<string>();
    body.items.forEach((item, index) => {
      if (item.id === null) return;
      if (!known.has(item.id) || seen.has(item.id)) {
        throw new ApiErrorException("validation_error", { fields: { [`items.${index}.id`]: "Not an item of this meal" } });
      }
      seen.add(item.id);
    });

    try {
      // Recalculate first, then compare against the stored items to mark what the user changed.
      const { items, totals } = recalculateMeal(body.items);
      changes.items = markUserEdits(items, before.items);
      changes.totals = totals;
    } catch (error) {
      if (!(error instanceof OversizedItemError)) throw error;
      throw tooLarge(`items.${error.index}.grams`);
    }
  }

  // The SQL function re-checks the version under a row lock, so a concurrent edit still gets a 409.
  const result = await updateMeal(supabase, mealId, changes);
  if (result.status === "not_found") throw new ApiErrorException("not_found");
  if (result.status === "version_conflict") throw new ApiErrorException("version_conflict");
  if (result.status === "invalid_item") {
    throw new ApiErrorException("validation_error", { fields: { items: "Not an item of this meal" } });
  }

  const meal = await findMeal(supabase, userId, mealId);
  if (!meal) throw new ApiErrorException("not_found");
  return { before, meal };
}
