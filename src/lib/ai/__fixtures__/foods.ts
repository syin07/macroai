import type { UsdaFood } from "@/lib/nutrition/usda";

// USDA foods for tool tests and the correction eval harness. No vitest imports, so the live eval
// runners can use them too.

// USDA SR Legacy 746776, values per 100 g.
export const SKIM_MILK: UsdaFood = {
  fdcId: 746776,
  description: "Milk, nonfat, fluid, with added vitamin A and vitamin D (fat free or skim)",
  dataType: "SR Legacy",
  brand: null,
  basis_per_100g: { calories: 34, protein_g: 3.37, carbs_g: 4.96, fat_g: 0.08 },
  portions: [{ amount: 1, unit: "cup", gramWeight: 245 }],
  serving: null,
};
