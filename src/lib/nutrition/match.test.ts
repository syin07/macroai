import { describe, expect, it, vi } from "vitest";
import type { Macros } from "@/types/api";
import { mealItemSchema } from "@/lib/validation";
import { fixtureLookup } from "./__fixtures__/fixture-client";
import { itemMacros, mealTotals } from "./calc";
import { matchAndCalculate, matchFood, rankCandidates, scoreCandidate, type ExtractedFood } from "./match";
import { UsdaError, type NutritionLookup, type UsdaFood } from "./usda";

const food = (fields: Partial<ExtractedFood> & Pick<ExtractedFood, "name" | "search_query">): ExtractedFood => ({
  quantity: 1,
  unit: "g",
  preparation: null,
  inferred: false,
  confidence: "medium",
  ...fields,
});

const basis: Macros = { calories: 100, protein_g: 10, carbs_g: 10, fat_g: 1 };
const usdaFood = (fields: Partial<UsdaFood> & Pick<UsdaFood, "fdcId" | "description">): UsdaFood => ({
  dataType: "SR Legacy",
  brand: null,
  basis_per_100g: basis,
  portions: [],
  serving: null,
  ...fields,
});

// Search fixtures, keyed by the query text match.ts sends.
const SEARCHES = {
  "chicken breast, grilled": "search-chicken-breast-grilled",
  "rice, white, cooked": "search-rice-white-cooked",
  "banana, raw": "search-banana",
  "Fairlife core power protein shake": "search-fairlife-core-power",
};

async function recorded(fixture: string): Promise<UsdaFood[]> {
  const query = Object.entries(SEARCHES).find(([, name]) => name === fixture)![0];
  return fixtureLookup(SEARCHES).lookup.searchFoods(query);
}

const grilledChicken = food({ name: "Grilled chicken breast", search_query: "chicken breast, grilled", preparation: "grilled" });
const whiteRice = food({ name: "Cooked white rice", search_query: "rice, white, cooked", preparation: "boiled" });
const banana = food({ name: "Banana", search_query: "banana, raw" });

describe("rankCandidates (recorded USDA results)", () => {
  it("picks the plain SR Legacy grilled chicken breast", async () => {
    const ranked = rankCandidates(grilledChicken, await recorded("search-chicken-breast-grilled"));
    expect(ranked[0]?.food.fdcId).toBe(171534);
    const accepted = ranked.map((r) => r.food.description);
    // Different foods that share words are never accepted.
    expect(accepted).not.toContainEqual(expect.stringMatching(/wing|thigh|drumstick|sandwich|tenders|Lunchmeat|WENDY|McDONALD/i));
  });

  it("picks cooked white rice and ranks rice cooked with fat below plain rice", async () => {
    const ranked = rankCandidates(whiteRice, await recorded("search-rice-white-cooked"));
    expect(ranked[0]?.food).toMatchObject({ fdcId: 168930, description: "Rice, white, medium-grain, cooked, unenriched" });
    const top5 = ranked.slice(0, 5).map((r) => r.food.description);
    expect(top5.every((d) => !/oil|butter|margarine|fat added|noodles/i.test(d))).toBe(true);
  });

  it("picks raw banana, not dried banana or banana desserts", async () => {
    const ranked = rankCandidates(banana, await recorded("search-banana"));
    expect(ranked[0]?.food).toMatchObject({ fdcId: 173944, description: "Bananas, raw" });
    expect(ranked.map((r) => r.food.description)).toEqual(["Bananas, raw", "Banana, raw", "Bananas, overripe, raw"]);
  });

  it.each([
    ["chicken thigh", food({ name: "Chicken thigh", search_query: "chicken thigh, grilled", preparation: "grilled" }), "search-chicken-breast-grilled"],
    ["turkey breast", food({ name: "Turkey breast", search_query: "turkey breast, roasted" }), "search-chicken-breast-grilled"],
    ["brown rice", food({ name: "Brown rice", search_query: "rice, brown, cooked" }), "search-rice-white-cooked"],
    ["plantain", food({ name: "Plantain", search_query: "plantain, cooked" }), "search-banana"],
  ])("accepts nothing for %s when only other foods were found", async (_label, extracted, fixture) => {
    expect(rankCandidates(extracted, await recorded(fixture))).toEqual([]);
  });

  it("matches the branded product when a brand is named", async () => {
    const shake = food({ name: "Core Power protein shake", search_query: "core power protein shake", brand: "Fairlife" });
    const ranked = rankCandidates(shake, await recorded("search-fairlife-core-power"));
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.every((r) => r.food.brand?.startsWith("CORE POWER"))).toBe(true);
    expect(ranked[0]?.food.fdcId).toBe(1935189);
  });
});

describe("scoreCandidate", () => {
  const cookedRice = usdaFood({ fdcId: 1, description: "Rice, white, long-grain, regular, enriched, cooked" });
  const rawRice = usdaFood({ fdcId: 2, description: "Rice, white, long-grain, regular, raw, enriched" });
  const dryPasta = usdaFood({ fdcId: 3, description: "Pasta, dry, enriched" });

  it("rejects raw vs cooked mismatches in either direction", () => {
    expect(scoreCandidate(whiteRice, rawRice)).toEqual({ ok: false, reason: "preparation_conflict" });
    const uncooked = food({ name: "Uncooked rice", search_query: "rice, white, raw" });
    expect(scoreCandidate(uncooked, cookedRice)).toEqual({ ok: false, reason: "preparation_conflict" });
    expect(scoreCandidate(food({ name: "Cooked spaghetti", search_query: "spaghetti, cooked" }), dryPasta)).toEqual({
      ok: false,
      reason: "preparation_conflict",
    });
  });

  it("reads preparation from the preparation field and the name, not just the search query", () => {
    const fromField = food({ name: "Rice", search_query: "rice, white", preparation: "steamed" });
    expect(scoreCandidate(fromField, rawRice)).toMatchObject({ ok: false, reason: "preparation_conflict" });
    expect(scoreCandidate(fromField, cookedRice)).toMatchObject({ ok: true });
  });

  it("does not read 'dry roasted' or 'dry heat' as raw", () => {
    const almonds = food({ name: "Roasted almonds", search_query: "almonds, roasted" });
    const candidate = usdaFood({ fdcId: 4, description: "Nuts, almonds, dry roasted, without salt added" });
    expect(scoreCandidate(almonds, candidate)).toMatchObject({ ok: true });

    const salmon = food({ name: "Baked salmon", search_query: "salmon, cooked", preparation: "baked" });
    const fish = usdaFood({ fdcId: 5, description: "Fish, salmon, Atlantic, farmed, cooked, dry heat" });
    expect(scoreCandidate(salmon, fish)).toMatchObject({ ok: true });
  });

  it("rejects candidates that lead with a different food", () => {
    const chicken = food({ name: "Chicken breast", search_query: "chicken breast, roasted" });
    expect(scoreCandidate(chicken, usdaFood({ fdcId: 6, description: "Soup, chicken noodle, canned" }))).toEqual({
      ok: false,
      reason: "unrelated_food",
    });
    expect(scoreCandidate(whiteRice, usdaFood({ fdcId: 7, description: "Rice flour, white, unenriched" }))).toEqual({
      ok: false,
      reason: "unrelated_food",
    });
  });

  it("looks past SR Legacy category prefixes", () => {
    const almondMilk = food({ name: "Almond milk", search_query: "almond milk, unsweetened" });
    const candidate = usdaFood({ fdcId: 8, description: "Beverages, almond milk, unsweetened, shelf stable" });
    expect(scoreCandidate(almondMilk, candidate)).toMatchObject({ ok: true });
  });

  it("uses synonyms for common names", () => {
    const toast = food({ name: "Whole wheat toast", search_query: "whole wheat toast" });
    const bread = usdaFood({ fdcId: 9, description: "Bread, whole-wheat, commercially prepared, toasted" });
    expect(scoreCandidate(toast, bread)).toMatchObject({ ok: true });
  });

  it("requires most of the query's food words", () => {
    const chickenThigh = food({ name: "Chicken thigh", search_query: "chicken thigh" });
    const breast = usdaFood({ fdcId: 10, description: "Chicken, broilers or fryers, breast, meat only, cooked, roasted" });
    expect(scoreCandidate(chickenThigh, breast)).toEqual({ ok: false, reason: "weak_name_match" });
  });

  it("ignores negated parts of USDA descriptions", () => {
    const plain = food({ name: "White rice", search_query: "rice, white, cooked" });
    const noFat = usdaFood({ fdcId: 11, dataType: "Survey (FNDDS)", description: "Rice, white, cooked, no added fat" });
    const withOil = usdaFood({ fdcId: 12, dataType: "Survey (FNDDS)", description: "Rice, white, cooked, made with oil" });
    const scoreNoFat = scoreCandidate(plain, noFat);
    const scoreOil = scoreCandidate(plain, withOil);
    expect(scoreNoFat).toMatchObject({ ok: true });
    // Rice made with oil isn't what was asked for; it scores lower (here, below the threshold).
    expect(scoreOil.ok ? scoreOil.score : 0).toBeLessThan(scoreNoFat.ok ? scoreNoFat.score : 0);
  });

  it("doesn't penalize a heavy modifier the user actually asked for", () => {
    const riceWithOil = food({ name: "Rice cooked with oil", search_query: "rice, white, cooked, with oil" });
    const withOil = usdaFood({ fdcId: 12, dataType: "Survey (FNDDS)", description: "Rice, white, cooked, made with oil" });
    expect(scoreCandidate(riceWithOil, withOil)).toMatchObject({ ok: true });
  });

  it("prefers Foundation / SR Legacy over FNDDS, and generic over branded when no brand is named", () => {
    const description = "Rice, white, cooked";
    const score = (dataType: string) => {
      const result = scoreCandidate(whiteRice, usdaFood({ fdcId: 13, dataType, description }));
      return result.ok ? result.score : 0;
    };
    expect(score("SR Legacy")).toBe(score("Foundation"));
    expect(score("SR Legacy")).toBeGreaterThan(score("Survey (FNDDS)"));
    expect(score("Survey (FNDDS)")).toBeGreaterThan(score("Branded"));
  });

  it("boosts branded candidates whose brand matches", () => {
    const yogurt = food({ name: "Chobani Greek yogurt", search_query: "greek yogurt plain nonfat", brand: "Chobani" });
    const chobani = usdaFood({ fdcId: 14, dataType: "Branded", description: "GREEK YOGURT, PLAIN, NONFAT", brand: "Chobani (Chobani, LLC)" });
    const other = usdaFood({ fdcId: 15, dataType: "Branded", description: "GREEK YOGURT, PLAIN, NONFAT", brand: "Great Value (Walmart Inc.)" });
    const a = scoreCandidate(yogurt, chobani);
    const b = scoreCandidate(yogurt, other);
    expect(a.ok && b.ok && a.score > b.score).toBe(true);
  });

  it("rejects an empty query", () => {
    expect(scoreCandidate(food({ name: "2", search_query: "" }), usdaFood({ fdcId: 16, description: "Rice, white" }))).toEqual({
      ok: false,
      reason: "weak_name_match",
    });
  });
});

describe("matchAndCalculate (recorded USDA data)", () => {
  const meal: ExtractedFood[] = [
    { ...grilledChicken, quantity: 150, unit: "g", confidence: "high" },
    { ...whiteRice, quantity: 1, unit: "cup" },
    { ...banana, quantity: 1, unit: "medium" },
    food({ name: "Core Power protein shake", search_query: "core power protein shake", brand: "Fairlife", quantity: 1, unit: "bottle", confidence: "high" }),
    food({ name: "Cooking oil", search_query: "oil, vegetable", quantity: 1, unit: "tsp", inferred: true, confidence: "low", notes: "Oil amount not visible" }),
  ];

  it("turns an extraction into USDA-backed MealItems, in order", async () => {
    const { lookup } = fixtureLookup(SEARCHES);
    const results = await matchAndCalculate(meal, lookup);

    expect(results.map((r) => r.status)).toEqual(["matched", "matched", "matched", "matched", "unmatched"]);
    expect(results.map((r) => r.food)).toEqual(meal);

    const items = results.flatMap((r) => (r.status === "matched" ? [r.item] : []));
    for (const item of items) expect(mealItemSchema.safeParse(item).success).toBe(true);

    const [chicken, rice, fruit, shake] = items;
    expect(chicken).toMatchObject({
      id: null,
      food_name: "Grilled chicken breast",
      quantity: 150,
      unit: "g",
      grams: 150,
      basis_per_100g: { calories: 151, protein_g: 30.5, carbs_g: 0, fat_g: 3.17 },
      nutrition_source: "usda",
      source_reference: "171534",
      inferred: false,
      confidence: "high",
      edited_by_user: false,
    });
    expect(chicken!.macros).toEqual(itemMacros(chicken!.basis_per_100g!, 150));
    expect(chicken!.assumptions).toContain("Chicken, broiler or fryers, breast");
    expect(chicken!.assumptions).toContain("FDC 171534");

    expect(rice).toMatchObject({ source_reference: "168930", grams: 160 });
    expect(rice!.assumptions).toContain("1 cup ≈ 160 g (typical for cooked grains)");

    expect(fruit).toMatchObject({ source_reference: "173944", grams: 118 });
    expect(fruit!.assumptions).toContain("USDA: 1 medium");

    expect(shake).toMatchObject({ source_reference: "1935189", grams: 340 });
    expect(shake!.macros.calories).toBeCloseTo(241.4, 9);
    expect(shake!.macros.protein_g).toBeCloseTo(26.01, 9);
    expect(shake!.assumptions).toContain("CORE POWER");

    const oil = results[4]!;
    expect(oil).toMatchObject({ status: "unmatched", reason: "no_match", match: null });

    expect(mealTotals(items).calories).toBeCloseTo(226.5 + 208 + 105.02 + 241.4, 9);
  });

  it("only fetches food details when the table can't size the portion", async () => {
    const { lookup, requests } = fixtureLookup(SEARCHES);
    await matchAndCalculate(meal, lookup);
    const details = requests.filter((r) => r.method === "GET").map((r) => r.url.split("/").pop());
    // Chicken (grams) and rice (cup, from the table) need no detail call; banana (size) and the shake (bottle) do.
    expect(details.sort()).toEqual(["173944", "1935189"]);
  });

  it("searches Branded first when a brand is named, then generic", async () => {
    const { lookup, requests } = fixtureLookup({});
    await matchFood(food({ name: "Fairlife 2% milk", search_query: "milk, 2%", brand: "Fairlife" }), lookup);
    expect(requests.map((r) => [r.body?.query, r.body?.dataType])).toEqual([
      ["Fairlife milk, 2%", ["Branded"]],
      ["milk, 2%", ["Foundation", "SR Legacy", "Survey (FNDDS)"]],
    ]);
  });
});

describe("matchFood", () => {
  const lookupOf = (overrides: Partial<NutritionLookup>): NutritionLookup => ({
    searchFoods: vi.fn(async () => []),
    getFood: vi.fn(async () => null),
    ...overrides,
  });
  const milk = usdaFood({ fdcId: 20, description: "Milk, reduced fat, fluid, 2% milkfat, with added vitamin A and vitamin D" });

  it("falls back to a generic equivalent when the named brand isn't found, and says so", async () => {
    const lookup = lookupOf({ searchFoods: vi.fn(async (_q, options) => (options?.dataTypes?.includes("Branded") ? [] : [milk])) });
    const extracted = food({ name: "Fairlife 2% milk", search_query: "milk, reduced fat, 2%", brand: "Fairlife", quantity: 240, unit: "ml" });
    const result = await matchFood(extracted, lookup);
    expect(result.status).toBe("matched");
    if (result.status !== "matched") return;
    expect(result.item.assumptions).toContain("no Fairlife product found; generic equivalent used");
    expect(result.item.grams).toBe(240);
  });

  it("skips candidates without nutrients, checking details first", async () => {
    const empty = usdaFood({ fdcId: 21, description: "Milk, reduced fat, 2%", basis_per_100g: null });
    const getFood = vi.fn(async () => empty);
    const lookup = lookupOf({ searchFoods: vi.fn(async () => [empty, milk]), getFood });
    const result = await matchFood(food({ name: "2% milk", search_query: "milk, reduced fat, 2%", quantity: 1, unit: "cup" }), lookup);
    expect(getFood).toHaveBeenCalledWith(21);
    expect(result.status === "matched" && result.item.source_reference).toBe("20");
  });

  it("reports unknown_portion with the match when grams can't be resolved", async () => {
    const lookup = lookupOf({ searchFoods: vi.fn(async () => [milk]) });
    const result = await matchFood(food({ name: "2% milk", search_query: "milk, reduced fat, 2%", quantity: 1, unit: "jug" }), lookup);
    expect(result).toMatchObject({ status: "unmatched", reason: "unknown_portion", match: { food: { fdcId: 20 } } });
  });

  it("reports no_match rather than substituting a different food", async () => {
    const lookup = lookupOf({ searchFoods: vi.fn(async () => [usdaFood({ fdcId: 22, description: "Soup, chicken noodle" })]) });
    const result = await matchFood(food({ name: "Chicken breast", search_query: "chicken breast, roasted", quantity: 100 }), lookup);
    expect(result).toMatchObject({ status: "unmatched", reason: "no_match", match: null });
  });

  it("reports lookup_failed per food when USDA is down", async () => {
    const lookup = lookupOf({
      searchFoods: vi.fn(async () => {
        throw new UsdaError("rate_limited", "USDA rate limit reached", 429);
      }),
    });
    const results = await matchAndCalculate([whiteRice, banana], lookup);
    expect(results.map((r) => r.status === "unmatched" && r.reason)).toEqual(["lookup_failed", "lookup_failed"]);
  });

  it("lets programming errors propagate", async () => {
    const lookup = lookupOf({
      searchFoods: vi.fn(async () => {
        throw new TypeError("boom");
      }),
    });
    await expect(matchFood(whiteRice, lookup)).rejects.toThrow("boom");
  });

  it("keeps assumptions within the contract's 1,000 characters", async () => {
    const lookup = lookupOf({ searchFoods: vi.fn(async () => [milk]) });
    const result = await matchFood(food({ name: "2% milk", search_query: "milk, reduced fat, 2%", quantity: 200, notes: "x".repeat(2000) }), lookup);
    expect(result.status === "matched" && result.item.assumptions?.length).toBe(1000);
  });
});
