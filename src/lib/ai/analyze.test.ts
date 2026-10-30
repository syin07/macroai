import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Macros } from "@/types/api";
import { ApiErrorException } from "@/lib/api-error";
import { itemMacros, mealTotals } from "@/lib/nutrition/calc";
import { UsdaError, type NutritionLookup, type UsdaFood } from "@/lib/nutrition/usda";
import { mealProposalSchema } from "@/lib/validation";
import { analyzeMeal, clarification, estimateDeviation, type AnalyzeMealDeps } from "./analyze";
import {
  ExtractionOutputError,
  extractionResultSchema,
  type ExtractedFood,
  type ExtractedMeal,
  type ExtractionResult,
} from "./extraction";
import { EXTRACT_MEAL_SYSTEM_PROMPT } from "./prompts/extract-meal";
import type { AIProvider, ExtractMealInput, ExtractMealOutput } from "./provider";
import { createUsageRecorder, usageRow, type UsageEntry } from "./usage";

// --- Fakes ---

const MODEL = "claude-haiku-5-5";
const USAGE = { inputTokens: 1200, outputTokens: 300 };

class FakeProvider implements AIProvider {
  readonly name = "anthropic" as const;
  readonly model = MODEL;
  readonly calls: ExtractMealInput[] = [];
  constructor(private readonly replies: Array<ExtractionResult | Error>) {}

  async extractMeal(input: ExtractMealInput): Promise<ExtractMealOutput> {
    this.calls.push(input);
    const reply = this.replies[Math.min(this.calls.length, this.replies.length) - 1]!;
    if (reply instanceof Error) throw reply;
    return { result: reply, usage: USAGE, model: MODEL, promptVersion: "extract-meal@test" };
  }

  chat(): never {
    throw new Error("not used");
  }
}

const invalidOutput = () => new ExtractionOutputError("Model output is not valid JSON", "{oops", { inputTokens: 1000, outputTokens: 50 });

const macros = (calories: number, protein_g: number, carbs_g: number, fat_g: number): Macros => ({ calories, protein_g, carbs_g, fat_g });

const usda = (fdcId: number, description: string, basis: Macros): UsdaFood => ({
  fdcId,
  description,
  dataType: "SR Legacy",
  brand: null,
  basis_per_100g: basis,
  portions: [],
  serving: null,
});

const EGG = usda(173424, "Egg, whole, cooked, hard-boiled", macros(155, 12.6, 1.1, 10.6));
const TOAST = usda(174928, "Bread, white, commercially prepared, toasted", macros(293, 9, 54.4, 4));
const OATS = usda(173904, "Cereals, oats, regular and quick, not fortified, dry", macros(379, 13.2, 67.7, 6.5));
const CHICKEN = usda(171534, "Chicken, broilers or fryers, breast, meat only, cooked, grilled", macros(151, 30.5, 0, 3.2));
const RICE = usda(168930, "Rice, white, medium-grain, cooked, unenriched", macros(130, 2.4, 28.6, 0.2));

function fakeLookup(results: Record<string, UsdaFood[]>): NutritionLookup & { searchFoods: ReturnType<typeof vi.fn> } {
  return {
    searchFoods: vi.fn(async (query: string) => results[query] ?? []),
    getFood: vi.fn(async () => null),
  };
}

const LOOKUP_RESULTS = {
  "egg, whole, cooked, hard-boiled": [EGG],
  "bread, white, toasted": [TOAST],
  "oats, dry": [OATS],
  "chicken breast, grilled": [CHICKEN],
  "rice, white, cooked": [RICE],
};

function extractedFood(fields: Partial<ExtractedFood> & Pick<ExtractedFood, "name" | "search_query">): ExtractedFood {
  return {
    brand: null,
    quantity: 1,
    unit: "piece",
    grams: null,
    preparation: null,
    estimated_quantity: false,
    inferred: false,
    confidence: "high",
    estimated_macros: macros(100, 5, 10, 3),
    estimate_range: { calories_low: 95, calories_high: 105, protein_g_low: 4, protein_g_high: 6 },
    notes: null,
    ...fields,
  };
}

const eggs = extractedFood({
  name: "Hard-boiled eggs",
  quantity: 2,
  unit: "egg",
  grams: 100,
  preparation: "boiled",
  search_query: "egg, whole, cooked, hard-boiled",
  estimated_macros: macros(155, 12.6, 1.1, 10.6),
  estimate_range: { calories_low: 140, calories_high: 170, protein_g_low: 11, protein_g_high: 14 },
});
const toast = extractedFood({
  name: "White toast",
  quantity: 1,
  unit: "slice",
  grams: 28,
  preparation: "toasted",
  search_query: "bread, white, toasted",
  confidence: "medium",
  estimated_macros: macros(80, 2.5, 15, 1),
  estimate_range: { calories_low: 70, calories_high: 100, protein_g_low: 2, protein_g_high: 3 },
});

function meal(fields: Partial<ExtractedMeal> & Pick<ExtractedMeal, "name" | "foods">): ExtractedMeal {
  return { consumed_at: null, time_phrase: null, needs_clarification: false, clarification_question: null, ...fields };
}

const logged = (...meals: ExtractedMeal[]): ExtractionResult => ({ intent: "log_meal", meals, explanation: null });

// Sunday 2026-10-25, 9 PM in Los Angeles.
const NOW = new Date("2026-10-25T21:00:00-07:00");
const USER = { id: "00000000-0000-4000-8000-000000000001", timezone: "America/Los_Angeles" };

function setup(replies: Array<ExtractionResult | Error>, overrides: Partial<AnalyzeMealDeps> = {}) {
  const provider = new FakeProvider(replies);
  const lookup = fakeLookup(LOOKUP_RESULTS);
  const usage: UsageEntry[] = [];
  let id = 0;
  const deps: AnalyzeMealDeps = {
    provider,
    lookup,
    recordUsage: async (entry) => void usage.push(entry),
    newId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    ...overrides,
  };
  const run = (text: string) => analyzeMeal({ text, user: USER, now: NOW }, deps);
  return { provider, lookup, usage, deps, run };
}

// --- Tests ---

describe("analyzeMeal: '2 eggs and toast'", () => {
  const reply = logged(meal({ name: "Eggs and Toast", foods: [eggs, toast] }));

  it("returns one valid proposal backed by USDA", async () => {
    const { run } = setup([reply]);
    const { intent, proposals } = await run("2 eggs and toast");

    expect(intent).toBe("log_meal");
    expect(proposals).toHaveLength(1);
    const [proposal] = proposals;
    expect(mealProposalSchema.parse(proposal)).toEqual(proposal);
    expect(proposal!.name).toBe("Eggs and Toast");
    expect(proposal!.consumed_at).toBe("2026-10-25T21:00:00-07:00"); // no time given → now
    expect(proposal!.needs_clarification).toBe(false);
    expect(proposal!.clarification_question).toBeNull();

    const [egg, bread] = proposal!.items;
    expect(egg).toMatchObject({ food_name: "Hard-boiled eggs", nutrition_source: "usda", source_reference: "173424", grams: 100 });
    expect(egg!.macros).toEqual(itemMacros(EGG.basis_per_100g!, 100));
    expect(bread).toMatchObject({ nutrition_source: "usda", source_reference: "174928" });
  });

  it("computes totals from the items with calc.ts, not the model's estimates", async () => {
    const { run } = setup([reply]);
    const [proposal] = (await run("2 eggs and toast")).proposals;
    expect(proposal!.totals).toEqual(mealTotals(proposal!.items));
    expect(proposal!.totals.calories).not.toBe(eggs.estimated_macros.calories + toast.estimated_macros.calories);
  });

  it("sends the text, the user's zone, and now in that zone to the provider", async () => {
    const { run, provider } = setup([reply]);
    await run("  2 eggs and toast  ");
    expect(provider.calls[0]).toEqual({
      text: "2 eggs and toast",
      image: undefined,
      now: "2026-10-25T21:00:00-07:00",
      timezone: "America/Los_Angeles",
      memories: [],
    });
  });

  it("passes memories when a loader is given", async () => {
    const loadMemories = vi.fn(async () => ["Usual toast: sourdough, 1 slice"]);
    const { run, provider } = setup([reply], { loadMemories });
    await run("2 eggs and toast");
    expect(loadMemories).toHaveBeenCalledWith(USER.id, "2 eggs and toast");
    expect(provider.calls[0]!.memories).toEqual(["Usual toast: sourdough, 1 slice"]);
  });
});

describe("analyzeMeal: no proposals", () => {
  it("'should I eat pizza?' produces none", async () => {
    const { run, lookup } = setup([
      { intent: "question", meals: [], explanation: "This is a question, not a meal to log." },
    ]);
    const result = await run("should I eat pizza?");
    expect(result).toMatchObject({ intent: "question", proposals: [], explanation: "This is a question, not a meal to log." });
    expect(lookup.searchFoods).not.toHaveBeenCalled();
  });

  it("ignores meals the model returned for a non-logging intent", async () => {
    const { run } = setup([{ intent: "question", meals: [meal({ name: "Pizza", foods: [toast] })], explanation: null }]);
    expect((await run("is pizza healthy?")).proposals).toEqual([]);
  });

  it("rejects empty input before calling the model", async () => {
    const { deps, provider } = setup([logged()]);
    await expect(analyzeMeal({ text: "   ", user: USER, now: NOW }, deps)).rejects.toMatchObject({ code: "validation_error" });
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects an unknown time zone", async () => {
    const { deps } = setup([logged()]);
    await expect(
      analyzeMeal({ text: "eggs", user: { ...USER, timezone: "Mars/Olympus" }, now: NOW }, deps),
    ).rejects.toMatchObject({ code: "validation_error" });
  });
});

describe("analyzeMeal: several meals in one message", () => {
  it("returns one proposal per meal, each with its own date and ID", async () => {
    const { run } = setup([
      logged(
        meal({ name: "Oatmeal", time_phrase: "this morning", foods: [extractedFood({ name: "Oats", search_query: "oats, dry", quantity: 40, unit: "g", grams: 40, preparation: "dry" })] }),
        meal({ name: "Chicken and Rice", time_phrase: "for lunch", foods: [
          extractedFood({ name: "Grilled chicken breast", search_query: "chicken breast, grilled", quantity: 150, unit: "g", grams: 150, preparation: "grilled" }),
          extractedFood({ name: "Cooked white rice", search_query: "rice, white, cooked", quantity: 1, unit: "cup", grams: 160, preparation: "boiled" }),
        ] }),
        meal({ name: "Eggs and Toast", time_phrase: "last night", foods: [eggs, toast] }),
      ),
    ]);
    const { proposals } = await run("oatmeal this morning, chicken and rice for lunch, and eggs and toast last night");

    expect(proposals.map((p) => [p.name, p.consumed_at, p.items.length])).toEqual([
      ["Oatmeal", "2026-10-25T08:00:00-07:00", 1],
      ["Chicken and Rice", "2026-10-25T12:30:00-07:00", 2],
      ["Eggs and Toast", "2026-10-24T20:00:00-07:00", 2],
    ]);
    expect(new Set(proposals.map((p) => p.proposal_id)).size).toBe(3);
    for (const proposal of proposals) {
      expect(mealProposalSchema.safeParse(proposal).success).toBe(true);
      expect(proposal.totals).toEqual(mealTotals(proposal.items));
    }
    expect(proposals[1]!.items.map((i) => i.source_reference)).toEqual(["171534", "168930"]);
  });

  it("prefers a parsed time phrase over the model's timestamp", async () => {
    const { run } = setup([
      logged(meal({ name: "Eggs", time_phrase: "yesterday at 8pm", consumed_at: "2026-10-25T20:00:00-07:00", foods: [eggs] })),
    ]);
    expect((await run("eggs yesterday at 8pm")).proposals[0]!.consumed_at).toBe("2026-10-24T20:00:00-07:00");
  });
});

describe("analyzeMeal: AI-only fallback", () => {
  const mystery = extractedFood({
    name: "Grandma's casserole",
    search_query: "casserole, homemade",
    quantity: 1,
    unit: "bowl",
    grams: 300,
    confidence: "low",
    estimated_macros: macros(450, 20, 40, 22),
    estimate_range: { calories_low: 400, calories_high: 500, protein_g_low: 17, protein_g_high: 23 },
    notes: "Assumed a medium bowl",
  });

  it("labels unmatched foods as AI estimates and uses the model's macros", async () => {
    const { run } = setup([logged(meal({ name: "Casserole", foods: [mystery] }))]);
    const [proposal] = (await run("a bowl of grandma's casserole")).proposals;
    const [item] = proposal!.items;

    expect(item).toMatchObject({
      nutrition_source: "ai",
      source_reference: null,
      basis_per_100g: null,
      grams: 300,
      macros: macros(450, 20, 40, 22),
      confidence: "low",
      assumptions: "AI estimate: no matching USDA food; Assumed a medium bowl",
    });
    expect(proposal!.totals).toEqual(macros(450, 20, 40, 22));
    expect(mealProposalSchema.safeParse(proposal).success).toBe(true);
  });

  it("falls back per food when USDA is down", async () => {
    const lookup: NutritionLookup = {
      searchFoods: async () => Promise.reject(new UsdaError("timeout", "USDA request timed out")),
      getFood: async () => null,
    };
    const { run } = setup([logged(meal({ name: "Eggs and Toast", foods: [eggs, toast] }))], { lookup });
    const [proposal] = (await run("2 eggs and toast")).proposals;
    expect(proposal!.items.map((i) => [i.nutrition_source, i.assumptions])).toEqual([
      ["ai", "AI estimate: nutrition database unavailable"],
      ["ai", "AI estimate: nutrition database unavailable"],
    ]);
    expect(proposal!.totals).toEqual(mealTotals(proposal!.items));
  });

  it("uses the USDA basis with the model's grams when only the portion is unknown", async () => {
    const odd = { ...eggs, quantity: 1, unit: "ramekin", grams: 120 };
    const { run } = setup([logged(meal({ name: "Baked eggs", foods: [odd] }))]);
    const [item] = (await run("a ramekin of eggs")).proposals[0]!.items;
    expect(item).toMatchObject({ nutrition_source: "usda", source_reference: "173424", grams: 120 });
    expect(item!.macros).toEqual(itemMacros(EGG.basis_per_100g!, 120));
    expect(item!.assumptions).toContain("AI portion estimate");
  });
});

describe("clarification rule (PRD FR-03)", () => {
  // 500 kcal meal: an item's estimate may be off by up to 100 kcal, or 15 g protein, in either direction.
  const totals = macros(500, 40, 50, 15);
  // A food whose point estimate sits at `point` in its range, or at the midpoint when not given.
  const withRange = (
    calories_low: number,
    calories_high: number,
    protein_g_low = 10,
    protein_g_high = 12,
    fields: Partial<ExtractedFood> & { point?: { calories: number; protein_g: number } } = {},
  ) => {
    const { point, ...rest } = fields;
    return extractedFood({
      name: "Chicken",
      search_query: "chicken",
      estimated_macros: macros(
        point?.calories ?? (calories_low + calories_high) / 2,
        point?.protein_g ?? (protein_g_low + protein_g_high) / 2,
        0,
        0,
      ),
      estimate_range: { calories_low, calories_high, protein_g_low, protein_g_high },
      ...rest,
    });
  };
  const ask = (foods: ExtractedFood[], clarification_question: string | null = null) => clarification({ foods, clarification_question }, totals);

  it("measures the larger deviation from the point estimate, never a negative one", () => {
    expect(estimateDeviation(600, 400, 900)).toBe(300);
    expect(estimateDeviation(248, 165, 330)).toBe(83);
    expect(estimateDeviation(100, 100, 100)).toBe(0);
    expect(estimateDeviation(50, 100, 120)).toBe(70); // point below its own bounds: the far side counts
  });

  it("does not ask when every item's estimate is within 20% of meal calories and 15 g protein of its bounds", () => {
    expect(ask([withRange(200, 300, 10, 25)])).toEqual({ needs_clarification: false, clarification_question: null });
    // A 180 kcal span would have asked under the old full-span rule; 90 kcal either way is within 100.
    expect(ask([withRange(160, 340, 10, 12)]).needs_clarification).toBe(false);
  });

  it("asks when one item's estimate could be off by more than 20% of the meal's calories", () => {
    const result = ask([withRange(100, 110), withRange(250, 401, 10, 12, { name: "Fried rice", point: { calories: 300, protein_g: 11 } })]);
    expect(result).toEqual({ needs_clarification: true, clarification_question: "About how much fried rice did you have?" });
  });

  it("asks when one item's protein estimate could be off by more than 15 g", () => {
    expect(ask([withRange(240, 260, 30, 45.5, { point: { calories: 250, protein_g: 30 } })]).needs_clarification).toBe(true);
    expect(ask([withRange(240, 260, 30, 45.5)]).needs_clarification).toBe(false); // midpoint: 7.75 g either way
  });

  it("'a bowl of pasta' at 400–900 kcal around 600 still asks", () => {
    const pasta = withRange(400, 900, 12, 30, { name: "Pasta", point: { calories: 600, protein_g: 20 } });
    expect(clarification({ foods: [pasta], clarification_question: null }, macros(600, 20, 90, 10))).toEqual({
      needs_clarification: true,
      clarification_question: "About how much pasta did you have?",
    });
  });

  it("asks about the most uncertain item, and keeps the model's question when it wrote one", () => {
    const foods = [withRange(200, 420, 10, 12, { name: "Rice" }), withRange(100, 400, 10, 12, { name: "Burger" })];
    expect(ask(foods).clarification_question).toBe("About how much burger did you have?");
    expect(ask(foods, "Which restaurant was the burger from?").clarification_question).toBe("Which restaurant was the burger from?");
  });

  it("ignores inferred hidden ingredients, however wide their range", () => {
    const oil = withRange(0, 150, 0, 0, { name: "Cooking oil", inferred: true, point: { calories: 40, protein_g: 0 } });
    expect(ask([oil])).toEqual({ needs_clarification: false, clarification_question: null });
    expect(ask([withRange(240, 260), oil]).needs_clarification).toBe(false);
    // The same range on a stated item does ask.
    expect(ask([{ ...oil, inferred: false }]).needs_clarification).toBe(true);
  });

  it("overrides the model's flag both ways", () => {
    expect(ask([withRange(240, 260)], "How big was it?").needs_clarification).toBe(false);
  });

  it("is applied to the meal's computed totals in analyzeMeal", async () => {
    const vague = { ...eggs, estimate_range: { calories_low: 50, calories_high: 400, protein_g_low: 4, protein_g_high: 30 } };
    const { run } = setup([logged(meal({ name: "Eggs and Toast", foods: [vague, toast] }))]);
    const [proposal] = (await run("some eggs and toast")).proposals;
    expect(proposal).toMatchObject({ needs_clarification: true, clarification_question: "About how much hard-boiled eggs did you have?" });
  });

  describe("the prompt's own chicken-and-rice example", () => {
    const example = () => {
      const line = EXTRACT_MEAL_SYSTEM_PROMPT.split("\n").find((l) => l.startsWith('{"intent":"log_meal"'));
      const [chickenAndRice] = extractionResultSchema.parse(JSON.parse(line!)).meals;
      return chickenAndRice!;
    };

    it("does not ask under the rule alone, with the model's own totals", () => {
      const chickenAndRice = example();
      expect(chickenAndRice.foods.map((f) => [f.name, f.inferred])).toEqual([
        ["Grilled chicken breast", false],
        ["Cooked white rice", false],
        ["Cooking oil", true],
      ]);
      const modelTotals = mealTotals(chickenAndRice.foods.map((f) => ({ macros: f.estimated_macros })));
      expect(clarification(chickenAndRice, modelTotals)).toEqual({ needs_clarification: false, clarification_question: null });
    });

    it("auto-saves through analyzeMeal with USDA matches, keeping the inferred oil in the meal", async () => {
      const lookup = fakeLookup({ "chicken, breast, grilled": [CHICKEN], "rice, white, cooked": [RICE] });
      const { run } = setup([logged(example())], { lookup });
      const [proposal] = (await run("had grilled chicken and rice for lunch")).proposals;
      expect(proposal).toMatchObject({ needs_clarification: false, clarification_question: null });
      expect(proposal!.items.map((i) => [i.food_name, i.inferred, i.nutrition_source])).toEqual([
        ["Grilled chicken breast", false, "usda"],
        ["Cooked white rice", false, "usda"],
        ["Cooking oil", true, "ai"],
      ]);
      expect(proposal!.totals).toEqual(mealTotals(proposal!.items));
    });
  });
});

describe("analyzeMeal: invalid model output", () => {
  const reply = logged(meal({ name: "Eggs", foods: [eggs] }));

  it("retries once and succeeds", async () => {
    const { run, provider, usage } = setup([invalidOutput(), reply]);
    const { proposals } = await run("2 eggs");
    expect(proposals).toHaveLength(1);
    expect(provider.calls).toHaveLength(2);
    expect(usage).toEqual([
      { model: MODEL, usage: { inputTokens: 1000, outputTokens: 50 } },
      { model: MODEL, usage: USAGE },
    ]);
  });

  it("fails with ai_unavailable after the retry, recording both calls", async () => {
    const { run, provider, usage } = setup([invalidOutput(), invalidOutput(), reply]);
    const error = await run("2 eggs").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiErrorException);
    expect(error).toMatchObject({ code: "ai_unavailable" });
    expect((error as Error).cause).toBeInstanceOf(ExtractionOutputError);
    expect(provider.calls).toHaveLength(2);
    expect(usage).toHaveLength(2);
  });

  it("does not retry provider errors (network, rate limit)", async () => {
    const { run, provider, usage } = setup([new Error("503 from provider"), reply]);
    await expect(run("2 eggs")).rejects.toMatchObject({ code: "ai_unavailable" });
    expect(provider.calls).toHaveLength(1);
    expect(usage).toEqual([]);
  });
});

describe("analyzeMeal: daily AI cap", () => {
  const reply = logged(meal({ name: "Eggs", foods: [eggs] }));
  const capAfter = (allowed: number) => {
    let checks = 0;
    return vi.fn(async () => {
      if (++checks > allowed) throw new ApiErrorException("ai_cap_reached");
    });
  };

  it("checks the cap before the extraction call", async () => {
    const checkCap = capAfter(0);
    const { run, provider, usage } = setup([reply], { checkCap });
    await expect(run("2 eggs")).rejects.toMatchObject({ code: "ai_cap_reached" });
    expect(provider.calls).toHaveLength(0);
    expect(usage).toHaveLength(0);
  });

  it("checks again before the retry, so a bad answer at cap - 1 can't go over", async () => {
    const checkCap = capAfter(1);
    const { run, provider, usage } = setup([invalidOutput(), reply], { checkCap });
    await expect(run("2 eggs")).rejects.toMatchObject({ code: "ai_cap_reached" });
    expect(checkCap).toHaveBeenCalledTimes(2);
    expect(provider.calls).toHaveLength(1);
    expect(usage).toHaveLength(1); // the first, billed call is still recorded
  });

  it("checks once per call on the normal path", async () => {
    const checkCap = vi.fn(async () => undefined);
    const { run } = setup([invalidOutput(), reply], { checkCap });
    await run("2 eggs");
    expect(checkCap).toHaveBeenCalledTimes(2);
  });
});

describe("analyzeMeal: photos (B9)", () => {
  const PHOTO = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), mediaType: "image/jpeg" as const };
  const fries = extractedFood({
    name: "French fries",
    quantity: 1,
    unit: "serving",
    grams: 120,
    preparation: "fried",
    search_query: "potatoes, french fried",
    estimated_quantity: true,
    confidence: "medium",
    estimated_macros: macros(370, 4, 48, 17),
    estimate_range: { calories_low: 300, calories_high: 440, protein_g_low: 3, protein_g_high: 5 },
  });
  const ranch = extractedFood({
    name: "Ranch dressing",
    quantity: 2,
    unit: "tbsp",
    grams: 30,
    search_query: "salad dressing, ranch",
    estimated_quantity: true,
    inferred: true,
    confidence: "low",
    estimated_macros: macros(129, 0.4, 1.8, 13.4),
    estimate_range: { calories_low: 65, calories_high: 200, protein_g_low: 0, protein_g_high: 1 },
    notes: "Dipping cup visible; assumed 2 tbsp",
  });

  it("sends the photo and its caption in one extraction call", async () => {
    const { provider, deps } = setup([logged(meal({ name: "Fries", foods: [fries] }))]);
    await analyzeMeal({ text: "fried, with ranch", image: PHOTO, user: USER, now: NOW }, deps);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({ text: "fried, with ranch", image: PHOTO });
  });

  it("accepts a photo with no text", async () => {
    const { provider, deps } = setup([logged(meal({ name: "Fries", foods: [fries] }))]);
    const { proposals } = await analyzeMeal({ image: PHOTO, user: USER, now: NOW }, deps);
    expect(proposals).toHaveLength(1);
    expect(provider.calls[0]!.text).toBeUndefined();
    expect(provider.calls[0]!.image).toBe(PHOTO);
  });

  it("keeps a hidden ingredient as its own inferred, low-confidence item", async () => {
    const { deps } = setup([logged(meal({ name: "Fries", foods: [fries, ranch] }))]);
    const { proposals } = await analyzeMeal({ image: PHOTO, user: USER, now: NOW }, deps);
    const items = proposals[0]!.items;
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ food_name: "Ranch dressing", inferred: true, confidence: "low" });
    expect(items[0]).toMatchObject({ inferred: false });
    expect(mealProposalSchema.safeParse(proposals[0]).success).toBe(true);
  });

  it("an unrecognizable photo gives no proposals and the model's short explanation", async () => {
    const explanation = "I can't make out the food in this photo. Could you describe it?";
    const { deps } = setup([{ intent: "other", meals: [], explanation }]);
    const analysis = await analyzeMeal({ image: PHOTO, user: USER, now: NOW }, deps);
    expect(analysis).toMatchObject({ intent: "other", proposals: [], explanation });
  });
});

describe("usage logging", () => {
  it("records every successful call", async () => {
    const { run, usage } = setup([logged(meal({ name: "Eggs", foods: [eggs] }))]);
    await run("2 eggs");
    expect(usage).toEqual([{ model: MODEL, usage: USAGE }]);
  });

  it("a failed usage insert doesn't lose the answer", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { run } = setup([logged(meal({ name: "Eggs", foods: [eggs] }))], {
      recordUsage: async () => Promise.reject(new Error("insert failed")),
    });
    expect((await run("2 eggs")).proposals).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(expect.any(String), "insert failed");
    error.mockRestore();
  });

  it("builds ai_usage rows with the priced cost", () => {
    expect(usageRow("u1", "ai/analyze-meal", { model: MODEL, usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } })).toEqual({
      user_id: "u1",
      endpoint: "ai/analyze-meal",
      model: MODEL,
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      estimated_cost_usd: 0.6,
    });
    expect(usageRow("u1", "ai/chat", { model: "unpriced-model", usage: USAGE }).estimated_cost_usd).toBe(0);
  });

  it("inserts through the user's client", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    const from = vi.fn(() => ({ insert }));
    const record = createUsageRecorder({ from } as unknown as SupabaseClient, "u1", "ai/analyze-meal");
    await record({ model: MODEL, usage: USAGE });
    expect(from).toHaveBeenCalledWith("ai_usage");
    expect(insert).toHaveBeenCalledWith(usageRow("u1", "ai/analyze-meal", { model: MODEL, usage: USAGE }));
  });
});
