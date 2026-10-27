import type { Macros, MealItem } from "@/types/api";

// Pure nutrition math (no I/O). The server recalculates with these on every save; the client may import
// them to preview totals. Values stay unrounded end to end; round only for display with round1().

export const ZERO_MACROS: Macros = Object.freeze({ calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });

function assertAmount(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite, non-negative number`);
}

export function scaleMacros(macros: Macros, factor: number): Macros {
  assertAmount(factor, "factor");
  return {
    calories: macros.calories * factor,
    protein_g: macros.protein_g * factor,
    carbs_g: macros.carbs_g * factor,
    fat_g: macros.fat_g * factor,
  };
}

// One item's contribution: basis is per 100 g.
export function itemMacros(basis: Macros, grams: number): Macros {
  assertAmount(grams, "grams");
  return scaleMacros(basis, grams / 100);
}

export function sumMacros(list: readonly Macros[]): Macros {
  return list.reduce<Macros>(
    (total, m) => ({
      calories: total.calories + m.calories,
      protein_g: total.protein_g + m.protein_g,
      carbs_g: total.carbs_g + m.carbs_g,
      fat_g: total.fat_g + m.fat_g,
    }),
    { ...ZERO_MACROS },
  );
}

// Meal (or day) total = sum of item contributions.
export function mealTotals(items: ReadonlyArray<Pick<MealItem, "macros">>): Macros {
  return sumMacros(items.map((item) => item.macros));
}

// targets − consumed. May be negative when over target; display as-is.
export function remaining(consumed: Macros, targets: Macros): Macros {
  return {
    calories: targets.calories - consumed.calories,
    protein_g: targets.protein_g - consumed.protein_g,
    carbs_g: targets.carbs_g - consumed.carbs_g,
    fat_g: targets.fat_g - consumed.fat_g,
  };
}

// The contract rule for saves: macros come from basis × grams / 100 whenever a basis exists;
// otherwise (manual / AI-only items) the given macros are kept.
export function withDerivedMacros<T extends Pick<MealItem, "basis_per_100g" | "grams" | "macros">>(item: T): T {
  if (item.basis_per_100g === null || item.grams === null) return item;
  return { ...item, macros: itemMacros(item.basis_per_100g, item.grams) };
}

// Display only. Rounds half away from zero to one decimal and never returns -0.
export function round1(value: number): number {
  const rounded = (Math.sign(value) * Math.round(Math.abs(value) * 10)) / 10;
  return rounded === 0 ? 0 : rounded;
}

export function round1Macros(macros: Macros): Macros {
  return {
    calories: round1(macros.calories),
    protein_g: round1(macros.protein_g),
    carbs_g: round1(macros.carbs_g),
    fat_g: round1(macros.fat_g),
  };
}

export interface AmountChange {
  quantity?: number; // new amount in the item's own unit
  grams?: number;    // new weight in grams
}

// A corrected amount ("make that 200 g", "I only ate half"). With a basis and a weight, macros are
// re-derived from grams; otherwise (AI or manual estimates) they scale with the amount. Throws
// RangeError when the change can't be applied: a new weight for an item with no basis and no known
// weight leaves nothing to scale from.
export function resizeItem<T extends Pick<MealItem, "quantity" | "grams" | "basis_per_100g" | "macros">>(
  item: T,
  change: AmountChange,
): T {
  if (change.quantity !== undefined) assertAmount(change.quantity, "quantity");
  if (change.grams !== undefined) assertAmount(change.grams, "grams");
  if (change.quantity === undefined && change.grams === undefined) return item;

  // How much the amount changed: the quantity ratio if given, else the weight ratio when known.
  const factor =
    change.quantity !== undefined && item.quantity > 0
      ? change.quantity / item.quantity
      : change.grams !== undefined && item.grams !== null && item.grams > 0
        ? change.grams / item.grams
        : null;

  const grams = change.grams ?? (item.grams !== null && factor !== null ? item.grams * factor : item.grams);
  const quantity = change.quantity ?? (factor !== null ? item.quantity * factor : item.quantity);

  if (item.basis_per_100g !== null && grams !== null) {
    return { ...item, quantity, grams, macros: itemMacros(item.basis_per_100g, grams) };
  }
  if (factor === null) throw new RangeError("No basis or known amount to scale this item from");
  return { ...item, quantity, grams, macros: scaleMacros(item.macros, factor) };
}
