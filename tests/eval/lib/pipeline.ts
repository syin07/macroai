import type { ExtractedFood, ExtractionResult } from "@/lib/ai/extraction";
import { itemMacros, sumMacros } from "@/lib/nutrition/calc";
import type { Macros } from "@/types/api";
import type { FoodBasis, NutritionLookup } from "./nutrition-lookup";

// Extraction → lookup → totals, the way B6 will do it: database basis × grams when there's a match,
// otherwise the model's own labeled estimate. Math comes from src/lib/nutrition/calc.ts.

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
        ? { food, match, source: "usda", macros: itemMacros(match.basisPer100g, food.grams) }
        : { food, match: null, source: "ai", macros: food.estimated_macros },
    );
  }
  return { foods, totals: sumMacros(foods.map((food) => food.macros)) };
}
