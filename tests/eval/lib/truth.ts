import { itemMacros, sumMacros } from "@/lib/nutrition/calc";
import type { ComputedTruth, Truth } from "./cases";
import type { NutritionLookup } from "./nutrition-lookup";

// True macros for a weighed meal: each component's USDA per-100 g values × its weighed grams.
export async function computeTruth(truth: Truth, lookup: NutritionLookup, now = new Date()): Promise<ComputedTruth> {
  const items = [];
  for (const item of truth.items) {
    const food = await lookup.getFood(item.fdc_id);
    if (!food) throw new Error(`USDA food ${item.fdc_id} (${item.name}) not found or has no energy value`);
    items.push({
      name: item.name,
      grams: item.grams,
      fdc_id: item.fdc_id,
      usda_description: food.description,
      basis_per_100g: food.basisPer100g,
      macros: itemMacros(food.basisPer100g, item.grams),
    });
  }
  return { computed_at: now.toISOString(), items, totals: sumMacros(items.map((item) => item.macros)) };
}
