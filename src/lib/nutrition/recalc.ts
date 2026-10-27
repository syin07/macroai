import type { Macros, MealItem } from "@/types/api";
import { macrosSchema } from "@/lib/validation/meal";
import { mealTotals, withDerivedMacros } from "./calc";

// Server-side recalculation for saves and edits (pure). Client-sent macros are replaced by
// basis_per_100g × grams / 100 whenever a basis exists; manual / AI-only items keep their macros.
// Totals are always recomputed from the items. Nothing is rounded.

type ItemInput = Pick<MealItem, "basis_per_100g" | "grams" | "macros">;

export interface RecalculatedMeal<T extends ItemInput> {
  items: T[];
  totals: Macros;
}

export class OversizedItemError extends Error {
  constructor(readonly index: number) {
    super(`item ${index} is too large`);
    this.name = "OversizedItemError";
  }
}

// Throws OversizedItemError when a derived item goes past the same sanity caps the request schema puts
// on client-sent macros (e.g. a 50,000 kcal/100 g basis × 10 kg).
export function recalculateMeal<T extends ItemInput>(items: readonly T[]): RecalculatedMeal<T> {
  const derived = items.map((item, index) => {
    const next = withDerivedMacros(item);
    if (!macrosSchema.safeParse(next.macros).success) throw new OversizedItemError(index);
    return next;
  });
  return { items: derived, totals: mealTotals(derived) };
}

// Fields a person changes when they edit an item. Numbers are compared at the database's precision
// (numeric(10,3)), so re-sending a stored value unchanged doesn't count as an edit.
const NUMERIC_TOLERANCE = 0.0005 + 1e-9;

function sameNumber(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= NUMERIC_TOLERANCE;
}

function sameMacros(a: Macros | null, b: Macros | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    sameNumber(a.calories, b.calories) &&
    sameNumber(a.protein_g, b.protein_g) &&
    sameNumber(a.carbs_g, b.carbs_g) &&
    sameNumber(a.fat_g, b.fat_g)
  );
}

export function itemChanged(next: Omit<MealItem, "id">, stored: MealItem): boolean {
  return !(
    next.food_name === stored.food_name &&
    sameNumber(next.quantity, stored.quantity) &&
    next.unit === stored.unit &&
    sameNumber(next.grams, stored.grams) &&
    sameMacros(next.basis_per_100g, stored.basis_per_100g) &&
    sameMacros(next.macros, stored.macros) &&
    next.nutrition_source === stored.nutrition_source &&
    next.source_reference === stored.source_reference
  );
}

// PATCH rule: new items and changed items are marked edited_by_user; once set, it stays set.
export function markUserEdits<T extends Omit<MealItem, "id"> & { id: string | null }>(
  items: readonly T[],
  stored: readonly MealItem[],
): T[] {
  const byId = new Map(stored.map((item) => [item.id, item]));
  return items.map((item) => {
    const previous = item.id === null ? undefined : byId.get(item.id);
    const edited = !previous || previous.edited_by_user || item.edited_by_user || itemChanged(item, previous);
    return { ...item, edited_by_user: edited };
  });
}
