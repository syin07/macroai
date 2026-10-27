import type { ExtractedFood, ExtractionResult } from "@/lib/ai/extraction";
import type { Macros } from "@/types/api";
import type { ComputedTruth, ExpectedItem, TextCase, Truth } from "./cases";

const GRAMS_TOLERANCE = 0.1;

// --- food identification ----------------------------------------------------------------------------

function haystack(food: ExtractedFood): string {
  return `${food.brand ?? ""} ${food.name} ${food.search_query}`.toLowerCase();
}

// Greedy one-to-one matching: each expected item claims the first unclaimed food whose brand, name, or
// search query mentions one of its keywords. Returns, per expected item, the index of the food it matched (or null).
export function matchItems(expected: { match: string[] }[], foods: ExtractedFood[]): (number | null)[] {
  const claimed = new Set<number>();
  return expected.map((item) => {
    const keywords = item.match.map((keyword) => keyword.toLowerCase());
    const index = foods.findIndex(
      (food, i) => !claimed.has(i) && keywords.some((keyword) => haystack(food).includes(keyword)),
    );
    if (index === -1) return null;
    claimed.add(index);
    return index;
  });
}

// Words of a truth item's name that identify it ("chicken breast, grilled" → chicken, breast).
const NON_IDENTIFYING = new Set([
  "raw", "cooked", "boiled", "baked", "fried", "grilled", "roasted", "steamed", "fresh", "plain",
  "with", "and", "without", "the", "large", "small", "medium", "whole", "sliced", "chopped",
]);

export function truthKeywords(item: Truth["items"][number]): string[] {
  const words = item.name
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word.length >= 3 && !NON_IDENTIFYING.has(word));
  return [...(item.aliases ?? []), ...words];
}

// Local calendar date of an ISO timestamp in an IANA zone.
export function localDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(iso),
  );
}

// --- text cases ---------------------------------------------------------------------------------------

export interface TextScore {
  intent_ok: boolean;
  meal_count_ok: boolean;
  items_expected: number;
  items_found: number;
  extra_items: number;              // stated (non-inferred) foods that match no expected item
  grams_checked: number;
  grams_ok: number;
  inferred_ok: boolean | null;      // null when the case doesn't check it
  clarification_ok: boolean | null;
  date_ok: boolean | null;
  pass: boolean;
}

export function scoreTextCase(testCase: TextCase, result: ExtractionResult): TextScore {
  const foods = result.meals.flatMap((meal) => meal.foods);
  const matches = matchItems(testCase.expected_items, foods);
  const matched = new Set(matches.filter((index): index is number => index !== null));

  const gramChecks = testCase.expected_items.flatMap((item: ExpectedItem, i) => {
    if (item.grams === undefined) return [];
    const index = matches[i];
    const grams = index === null || index === undefined ? null : foods[index]!.grams;
    return [grams !== null && Math.abs(grams - item.grams) <= item.grams * GRAMS_TOLERANCE];
  });

  const hasInferred = foods.some((food) => food.inferred);
  const askedClarification = result.meals.some((meal) => meal.needs_clarification);
  const dates = result.meals.map((meal) => meal.consumed_at);

  const score: Omit<TextScore, "pass"> = {
    intent_ok: result.intent === testCase.expected_intent,
    meal_count_ok: result.meals.length === testCase.expected_meals,
    items_expected: testCase.expected_items.length,
    items_found: matched.size,
    extra_items: foods.filter((food, i) => !food.inferred && !matched.has(i)).length,
    grams_checked: gramChecks.length,
    grams_ok: gramChecks.filter(Boolean).length,
    inferred_ok: testCase.expect_inferred === undefined ? null : hasInferred === testCase.expect_inferred,
    clarification_ok:
      testCase.expect_clarification === undefined ? null : askedClarification === testCase.expect_clarification,
    date_ok:
      testCase.expected_local_date === undefined
        ? null
        : dates.length > 0 &&
          dates.every((iso) => iso !== null && localDate(iso, testCase.timezone) === testCase.expected_local_date),
  };

  return {
    ...score,
    pass:
      score.intent_ok &&
      score.meal_count_ok &&
      score.items_found === score.items_expected &&
      score.grams_ok === score.grams_checked &&
      score.inferred_ok !== false &&
      score.clarification_ok !== false &&
      score.date_ok !== false,
  };
}

// --- photo cases -------------------------------------------------------------------------------------

export interface PhotoScore {
  true_calories: number;
  predicted_calories: number;
  calorie_error_pct: number;  // signed: negative = underestimate
  true_protein_g: number;
  predicted_protein_g: number;
  protein_error_g: number;    // signed
  items_expected: number;
  items_found: number;
}

export function scorePhotoCase(truth: Truth, computed: ComputedTruth, result: ExtractionResult, predicted: Macros): PhotoScore {
  const foods = result.meals.flatMap((meal) => meal.foods);
  const matches = matchItems(
    truth.items.map((item) => ({ match: truthKeywords(item) })),
    foods,
  );
  return {
    true_calories: computed.totals.calories,
    predicted_calories: predicted.calories,
    calorie_error_pct:
      computed.totals.calories > 0
        ? ((predicted.calories - computed.totals.calories) / computed.totals.calories) * 100
        : 0,
    true_protein_g: computed.totals.protein_g,
    predicted_protein_g: predicted.protein_g,
    protein_error_g: predicted.protein_g - computed.totals.protein_g,
    items_expected: truth.items.length,
    items_found: matches.filter((index) => index !== null).length,
  };
}

// --- statistics -------------------------------------------------------------------------------------

export function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Linear interpolation between closest ranks; p in [0, 100].
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low);
}

export function median(values: number[]): number | null {
  return percentile(values, 50);
}
