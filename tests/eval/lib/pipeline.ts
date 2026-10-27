import type { ExtractedFood, ExtractionResult } from "@/lib/ai/extraction";
import type { Macros } from "@/types/api";
import type { FoodBasis, NutritionLookup } from "./nutrition-lookup";

// Extraction → lookup → totals, the way B6 will do it: database basis × grams when there's a match,
// otherwise the model's own labeled estimate. The two math helpers stand in for
// src/lib/nutrition/calc.ts (B5, in progress on another branch); switch to it once it merges.

export const ZERO_MACROS: Macros = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };

export function macrosForGrams(basis: Macros, grams: number): Macros {
  const factor = grams / 100;
  return {
    calories: basis.calories * factor,
    protein_g: basis.protein_g * factor,
    carbs_g: basis.carbs_g * factor,
    fat_g: basis.fat_g * factor,
  };
}

export function sumMacros(items: Macros[]): Macros {
  return items.reduce(
    (total, item) => ({
      calories: total.calories + item.calories,
      protein_g: total.protein_g + item.protein_g,
      carbs_g: total.carbs_g + item.carbs_g,
      fat_g: total.fat_g + item.fat_g,
    }),
    ZERO_MACROS,
  );
}

export interface PricedFood {
  food: ExtractedFood;
  match: FoodBasis | null;
  source: "usda" | "ai";
  macros: Macros;
}

export async function priceExtraction(
  result: ExtractionResult,
  lookup: NutritionLookup,
): Promise<{ foods: PricedFood[]; totals: Macros }> {
  const foods: PricedFood[] = [];
  for (const food of result.meals.flatMap((meal) => meal.foods)) {
    const match =
      food.grams === null
        ? null
        : await lookup.search({
            searchQuery: food.search_query,
            name: food.name,
            preparation: food.preparation,
            brand: food.brand,
          });
    foods.push(
      match && food.grams !== null
        ? { food, match, source: "usda", macros: macrosForGrams(match.basisPer100g, food.grams) }
        : { food, match: null, source: "ai", macros: food.estimated_macros },
    );
  }
  return { foods, totals: sumMacros(foods.map((food) => food.macros)) };
}
