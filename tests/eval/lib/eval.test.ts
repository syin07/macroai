import { describe, expect, it, vi } from "vitest";
import { ExtractionOutputError, type ExtractedFood, type ExtractionResult } from "@/lib/ai/extraction";
import type { AIProvider } from "@/lib/ai/provider";
import { renderSummary, runBakeoff, summarize } from "./bakeoff";
import { loadTextCases, parseTextCases, textCaseSchema, type PhotoCase } from "./cases";
import { UsdaApiLookup, basisFromUsdaFood, type FoodBasis, type NutritionLookup } from "./nutrition-lookup";
import { priceExtraction } from "./pipeline";
import { localDate, matchItems, median, percentile, scorePhotoCase, scoreTextCase, truthKeywords } from "./score";
import { computeTruth } from "./truth";

function food(overrides: Partial<ExtractedFood> = {}): ExtractedFood {
  return {
    name: "Food",
    brand: null,
    quantity: 1,
    unit: "piece",
    grams: 100,
    preparation: null,
    estimated_quantity: true,
    inferred: false,
    confidence: "medium",
    search_query: "food",
    estimated_macros: { calories: 100, protein_g: 10, carbs_g: 10, fat_g: 2 },
    estimate_range: { calories_low: 80, calories_high: 120, protein_g_low: 8, protein_g_high: 12 },
    notes: null,
    ...overrides,
  };
}

function result(foods: ExtractedFood[][], overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    intent: "log_meal",
    meals: foods.map((mealFoods) => ({
      name: "Meal",
      consumed_at: null,
      time_phrase: null,
      foods: mealFoods,
      needs_clarification: false,
      clarification_question: null,
    })),
    explanation: null,
    ...overrides,
  };
}

const basis = (fdcId: number, calories: number, protein_g: number): FoodBasis => ({
  fdcId,
  description: `food ${fdcId}`,
  dataType: "SR Legacy",
  basisPer100g: { calories, protein_g, carbs_g: 0, fat_g: 0 },
});

describe("text-cases.jsonl", () => {
  it("has 20+ valid cases covering the required kinds", async () => {
    const cases = await loadTextCases();
    expect(cases.length).toBeGreaterThanOrEqual(20);
    const categories = new Set(cases.map((c) => c.category));
    for (const category of ["simple", "multi_item", "informal_units", "multi_meal", "hypothetical"]) {
      expect(categories).toContain(category);
    }
    expect(cases.find((c) => c.input === "should I eat pizza?")).toMatchObject({ expected_meals: 0, expected_items: [] });
    expect(cases.some((c) => c.expected_meals === 3)).toBe(true);
  });

  it("rejects duplicate ids and reports the bad line", () => {
    const line = JSON.stringify({ id: "a", category: "simple", input: "x", expected_meals: 1, expected_items: [] });
    expect(() => parseTextCases(`${line}\n${line}`)).toThrow(/duplicate id a/);
    expect(() => parseTextCases(`${line}\n{"id":"b"}`)).toThrow(/line 2/);
  });
});

describe("matchItems", () => {
  it("matches one-to-one by keyword in brand, name, or search query", () => {
    const foods = [food({ name: "Fried egg" }), food({ name: "Egg white" }), food({ name: "Shake", brand: "Fairlife" })];
    expect(matchItems([{ match: ["egg"] }, { match: ["egg"] }, { match: ["egg"] }, { match: ["fairlife"] }], foods)).toEqual([
      0,
      1,
      null,
      2,
    ]);
  });

  it("derives identifying words from truth names", () => {
    expect(truthKeywords({ name: "Chicken breast, grilled", grams: 1, fdc_id: 1, aliases: ["poultry"] })).toEqual([
      "poultry",
      "chicken",
      "breast",
    ]);
  });
});

describe("scoreTextCase", () => {
  const testCase = textCaseSchema.parse({
    id: "t",
    category: "explicit_weight",
    input: "150g chicken and rice last night",
    expected_meals: 1,
    expected_items: [{ match: ["chicken"], grams: 150 }, { match: ["rice"] }],
    expect_inferred: true,
    expected_local_date: "2026-10-25",
  });

  it("passes a correct extraction", () => {
    const extraction = result([
      [food({ name: "Chicken breast", grams: 160 }), food({ name: "White rice" }), food({ name: "Oil", inferred: true })],
    ]);
    extraction.meals[0]!.consumed_at = "2026-10-25T19:00:00-07:00";
    const score = scoreTextCase(testCase, extraction);
    expect(score).toMatchObject({ items_found: 2, extra_items: 0, grams_ok: 1, inferred_ok: true, date_ok: true });
    expect(score.pass).toBe(true);
  });

  it("fails stated weights off by more than 10%, missing foods, and wrong dates", () => {
    const extraction = result([[food({ name: "Chicken", grams: 200 }), food({ name: "Salad" })]]);
    extraction.meals[0]!.consumed_at = "2026-10-26T19:00:00-07:00";
    const score = scoreTextCase(testCase, extraction);
    expect(score).toMatchObject({ items_found: 1, extra_items: 1, grams_ok: 0, inferred_ok: false, date_ok: false });
    expect(score.pass).toBe(false);
  });

  it("passes a hypothetical only when nothing is logged", () => {
    const hypothetical = textCaseSchema.parse({
      id: "h",
      category: "hypothetical",
      input: "should I eat pizza?",
      expected_intent: "question",
      expected_meals: 0,
      expected_items: [],
    });
    expect(scoreTextCase(hypothetical, result([], { intent: "question" })).pass).toBe(true);
    expect(scoreTextCase(hypothetical, result([[food({ name: "Pizza" })]])).pass).toBe(false);
  });

  it("reads local dates in the case's time zone", () => {
    expect(localDate("2026-10-26T05:00:00Z", "America/Los_Angeles")).toBe("2026-10-25");
    expect(localDate("2026-10-26T05:00:00Z", "Europe/Berlin")).toBe("2026-10-26");
  });
});

describe("statistics", () => {
  it("computes percentiles with interpolation", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(percentile([0, 10], 90)).toBe(9);
    expect(median([])).toBeNull();
  });
});

describe("basisFromUsdaFood", () => {
  it("reads search-result nutrients", () => {
    const food = {
      fdcId: 171477,
      description: "Chicken, broilers or fryers, breast, meat only, cooked, roasted",
      dataType: "SR Legacy",
      foodNutrients: [
        { nutrientId: 1008, unitName: "KCAL", value: 165 },
        { nutrientId: 1003, unitName: "G", value: 31 },
        { nutrientId: 1004, unitName: "G", value: 3.57 },
      ],
    };
    expect(basisFromUsdaFood(food)?.basisPer100g).toEqual({ calories: 165, protein_g: 31, carbs_g: 0, fat_g: 3.57 });
  });

  it("reads detail nutrients and falls back to Atwater energy", () => {
    const food = {
      fdcId: 1,
      description: "Foundation food",
      dataType: "Foundation",
      foodNutrients: [
        { nutrient: { id: 1062, unitName: "kJ" }, amount: 500 },
        { nutrient: { id: 2047, unitName: "kcal" }, amount: 120 },
        { nutrient: { id: 1005, unitName: "g" }, amount: 20 },
      ],
    };
    expect(basisFromUsdaFood(food)?.basisPer100g.calories).toBe(120);
  });

  it("returns null without a kcal energy value", () => {
    const food = { fdcId: 1, description: "x", foodNutrients: [{ nutrientId: 1062, unitName: "kJ", value: 500 }] };
    expect(basisFromUsdaFood(food)).toBeNull();
  });
});

describe("UsdaApiLookup", () => {
  function fakeFetch(body: unknown, status = 200) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status }));
  }

  it("takes the first hit with energy, searches Branded when a brand is named, and caches", async () => {
    const fetchImpl = fakeFetch({
      foods: [
        { fdcId: 1, description: "no energy", foodNutrients: [] },
        { fdcId: 2, description: "yogurt", dataType: "Branded", foodNutrients: [{ nutrientId: 1008, unitName: "KCAL", value: 80 }] },
      ],
    });
    const lookup = new UsdaApiLookup({ apiKey: "secret", fetchImpl });
    const query = { searchQuery: "yogurt, greek, vanilla", name: "Greek yogurt", preparation: null, brand: "Chobani" };

    expect((await lookup.search(query))?.fdcId).toBe(2);
    await lookup.search(query);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain("secret");
    expect((init.headers as Record<string, string>)["X-Api-Key"]).toBe("secret");
    expect(JSON.parse(init.body as string)).toMatchObject({ query: "Chobani yogurt, greek, vanilla", dataType: ["Branded"] });
  });

  it("returns null for an unknown FDC ID", async () => {
    const lookup = new UsdaApiLookup({ fetchImpl: fakeFetch({}, 404) });
    expect(await lookup.getFood(999)).toBeNull();
  });
});

describe("priceExtraction and computeTruth", () => {
  const lookup: NutritionLookup = {
    search: async (query) => (query.searchQuery === "rice" ? basis(1, 130, 2.7) : null),
    getFood: async (fdcId) => (fdcId === 1 ? basis(1, 130, 2.7) : null),
  };

  it("uses database basis × grams when matched, else the model's estimate", async () => {
    const priced = await priceExtraction(
      result([[food({ search_query: "rice", grams: 200 }), food({ search_query: "mystery stew" })]]),
      lookup,
    );
    expect(priced.foods.map((f) => f.source)).toEqual(["usda", "ai"]);
    expect(priced.totals.calories).toBeCloseTo(260 + 100);
    expect(priced.totals.protein_g).toBeCloseTo(5.4 + 10);
  });

  it("computes weighed truth from FDC IDs and fails loudly on unknown IDs", async () => {
    const truth = await computeTruth({ items: [{ name: "Rice", grams: 150, fdc_id: 1 }] }, lookup, new Date(0));
    expect(truth.totals.calories).toBeCloseTo(195);
    await expect(computeTruth({ items: [{ name: "X", grams: 1, fdc_id: 2 }] }, lookup)).rejects.toThrow(/2 \(X\)/);
  });

  it("scores photo calorie error as signed percent", () => {
    const truth = { items: [{ name: "White rice", grams: 150, fdc_id: 1 }] };
    const computed = {
      computed_at: new Date(0).toISOString(),
      items: [],
      totals: { calories: 200, protein_g: 4, carbs_g: 44, fat_g: 0 },
    };
    const score = scorePhotoCase(truth, computed, result([[food({ name: "Steamed rice" })]]), {
      calories: 150,
      protein_g: 5,
      carbs_g: 30,
      fat_g: 0,
    });
    expect(score).toMatchObject({ calorie_error_pct: -25, protein_error_g: 1, items_found: 1 });
  });
});

describe("runBakeoff (dry run with a fake provider)", () => {
  const lookup: NutritionLookup = { search: async () => basis(1, 100, 10), getFood: async () => basis(1, 100, 10) };

  function fakeProvider(name: AIProvider["name"], model: string, reply: () => ExtractionResult): AIProvider {
    return {
      name,
      model,
      extractMeal: async () => ({ result: reply(), usage: { inputTokens: 1000, outputTokens: 200 }, model, promptVersion: "test" }),
      chat: async () => {
        throw new Error("not used");
      },
    };
  }

  it("records valid, invalid, and failed calls and summarizes them per provider", async () => {
    const textCases = parseTextCases(
      [
        { id: "a", category: "simple", input: "a banana", expected_meals: 1, expected_items: [{ match: ["banana"] }] },
        { id: "b", category: "simple", input: "an apple", expected_meals: 1, expected_items: [{ match: ["apple"] }] },
      ]
        .map((c) => JSON.stringify(c))
        .join("\n"),
    );
    const photoCase: PhotoCase = {
      id: "p1",
      dir: "",
      photoFile: new URL(import.meta.url).pathname, // any readable file stands in for the photo
      mediaType: "image/jpeg",
      truth: { items: [{ name: "Banana", grams: 120, fdc_id: 1 }] },
      computed: { computed_at: new Date(0).toISOString(), items: [], totals: { calories: 100, protein_g: 10, carbs_g: 0, fat_g: 0 } },
    };

    let calls = 0;
    const flaky: AIProvider = {
      ...fakeProvider("openai", "unpriced-model", () => result([])),
      extractMeal: async () => {
        calls++;
        if (calls === 1) throw new ExtractionOutputError("Model output is not valid JSON", "oops", { inputTokens: 10, outputTokens: 5 });
        throw new Error("503 Service Unavailable");
      },
    };

    const records = await runBakeoff({
      providers: [fakeProvider("anthropic", "claude-haiku-5-5", () => result([[food({ name: "Banana", grams: 120 })]])), flaky],
      lookup,
      textCases,
      photoCases: [photoCase],
    });

    expect(records).toHaveLength(6);
    expect(records.filter((r) => r.provider === "openai").map((r) => r.status)).toEqual(["invalid_output", "error", "error"]);
    expect(records.find((r) => r.provider === "openai")?.raw_output).toBe("oops");

    const [claude, openai] = summarize(records);
    expect(claude!.text).toMatchObject({ cases: 2, valid_pct: 100, pass_pct: 50, item_recall_pct: 50, lookup_hit_pct: 100 });
    expect(claude!.photo.calorie_abs_error_pct_median).toBeCloseTo(20); // 120 g × 100 kcal/100 g vs 100 kcal truth
    expect(claude!.text.cost_per_1000_usd).toBeCloseTo(((1000 * 0.1 + 200 * 0.5) / 1e6) * 1000);
    expect(openai!.text).toMatchObject({ errors: 1, valid_pct: 0, cost_per_1000_usd: null });

    const markdown = renderSummary([claude!, openai!], { promptVersion: "test", lookup: "fake" });
    expect(markdown).toContain("| Calorie error, median abs | 20.0% | n/a |");
  });
});
