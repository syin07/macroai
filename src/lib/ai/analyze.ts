import type { Macros, MealItem, MealProposal } from "@/types/api";
import { ApiErrorException } from "@/lib/api-error";
import { mealTotals } from "@/lib/nutrition/calc";
import type { NutritionCache } from "@/lib/nutrition/cache";
import { buildItem, matchAndCalculate, type FoodMatchResult } from "@/lib/nutrition/match";
import type { NutritionLookup } from "@/lib/nutrition/usda";
import { isValidTimeZone } from "@/lib/validation/common";
import { inUserZone, resolveConsumedAt } from "./dates";
import {
  ExtractionOutputError,
  type ExtractedFood,
  type ExtractedMeal,
  type ExtractionIntent,
} from "./extraction";
import type { AIProvider, ExtractMealInput, ExtractMealOutput, MealImage } from "./provider";
import type { RecordUsage, UsageEntry } from "./usage";

// Text and/or photo → meal proposals (PRD §5.5). The model only extracts; nutrition comes from
// USDA matches where possible, all math runs through calc.ts, and dates are resolved in code. Nothing
// is saved here: proposals go back to the caller (B8's create_meal_proposal tool, or the eval route).

const MAX_ATTEMPTS = 2; // one retry when the model's output fails the schema
const MAX_ASSUMPTIONS_LENGTH = 1000;

// PRD FR-03: ask only when one item's uncertainty could move the meal by more than this.
export const CLARIFY_CALORIE_SHARE = 0.2;
export const CLARIFY_PROTEIN_G = 15;

export interface AnalyzeUser {
  id: string;
  timezone: string; // IANA, from account_preferences
}

export interface AnalyzeMealInput {
  text?: string;
  image?: MealImage; // passed straight to the provider; never stored or logged (PRD FR-15)
  user: AnalyzeUser;
  now?: Date;
}

export interface AnalyzeMealDeps {
  provider: AIProvider;
  lookup: NutritionLookup;
  cache?: NutritionCache;
  recordUsage: RecordUsage;
  // Relevant saved memories for this message: pass memoryLoader(supabase) from src/lib/memory/retrieve.ts.
  loadMemories?: (userId: string, text: string | undefined) => Promise<string[]>;
  // Runs before every extraction call, the retry included; throws ApiErrorException("ai_cap_reached")
  // at the daily cap. AI routes pass their AiCapGuard's check (cap.ts).
  checkCap?: () => Promise<unknown>;
  newId?: () => string;
}

export interface MealAnalysis {
  intent: ExtractionIntent;
  proposals: MealProposal[];   // empty unless the user logged food
  explanation: string | null;  // the model's reason when there are no proposals
  model: string;
  promptVersion: string;
}

export async function analyzeMeal(input: AnalyzeMealInput, deps: AnalyzeMealDeps): Promise<MealAnalysis> {
  const text = input.text?.trim() || undefined;
  if (!text && !input.image) {
    throw new ApiErrorException("validation_error", { fields: { text: "Describe the meal or add a photo." } });
  }
  const { user } = input;
  if (!isValidTimeZone(user.timezone)) {
    throw new ApiErrorException("validation_error", { fields: { timezone: "Unknown time zone" } });
  }
  const now = input.now ?? new Date();

  const memories = deps.loadMemories ? await deps.loadMemories(user.id, text) : [];
  const extraction = await extractWithRetry(
    { text, image: input.image, now: inUserZone(now, user.timezone), timezone: user.timezone, memories },
    deps,
  );

  const { intent, meals, explanation } = extraction.result;
  const proposals =
    intent === "log_meal"
      ? await Promise.all(meals.map((meal) => toProposal(meal, { now, timezone: user.timezone }, deps)))
      : [];

  return { intent, proposals, explanation, model: extraction.model, promptVersion: extraction.promptVersion };
}

// --- Extraction ---

function aiUnavailable(cause: unknown): ApiErrorException {
  const error = new ApiErrorException("ai_unavailable");
  error.cause = cause; // for the route's server log; never sent to the client
  return error;
}

async function extractWithRetry(input: ExtractMealInput, deps: AnalyzeMealDeps): Promise<ExtractMealOutput> {
  for (let attempt = 1; ; attempt++) {
    await deps.checkCap?.(); // ai_cap_reached propagates as is (429, or the chat turn ends early)
    let output: ExtractMealOutput;
    try {
      output = await deps.provider.extractMeal(input);
    } catch (error) {
      if (!(error instanceof ExtractionOutputError)) throw aiUnavailable(error);
      // The model answered, so the call was billed: record it before retrying.
      await recordUsage(deps, { model: deps.provider.model, usage: error.usage });
      if (attempt >= MAX_ATTEMPTS) throw aiUnavailable(error);
      continue;
    }
    await recordUsage(deps, { model: output.model, usage: output.usage });
    return output;
  }
}

// A failed usage insert must not throw away an answer that was already paid for.
async function recordUsage(deps: AnalyzeMealDeps, entry: UsageEntry): Promise<void> {
  try {
    await deps.recordUsage(entry);
  } catch (error) {
    console.error("analyzeMeal: could not record AI usage", error instanceof Error ? error.message : error);
  }
}

// --- Proposals ---

async function toProposal(
  meal: ExtractedMeal,
  when: { now: Date; timezone: string },
  deps: AnalyzeMealDeps,
): Promise<MealProposal> {
  const results = await matchAndCalculate(meal.foods, deps.lookup, deps.cache);
  const items = results.map((result, i) => toItem(meal.foods[i]!, result));
  const totals = mealTotals(items);
  return {
    proposal_id: deps.newId?.() ?? crypto.randomUUID(),
    name: meal.name,
    consumed_at: resolveConsumedAt({
      timePhrase: meal.time_phrase,
      modelConsumedAt: meal.consumed_at,
      now: when.now,
      timezone: when.timezone,
    }),
    items,
    totals,
    ...clarification(meal, totals),
  };
}

const AI_ONLY_REASON: Record<Exclude<FoodMatchResult, { status: "matched" }>["reason"], string> = {
  no_match: "AI estimate: no matching USDA food",
  unknown_portion: "AI estimate: portion couldn't be converted to grams",
  lookup_failed: "AI estimate: nutrition database unavailable",
};

function toItem(food: ExtractedFood, result: FoodMatchResult): MealItem {
  if (result.status === "matched") return result.item;

  // USDA knows the food but our unit tables don't know the portion: the model's gram estimate times
  // the USDA basis beats an AI-only guess.
  const basis = result.match?.food.basis_per_100g;
  if (result.reason === "unknown_portion" && result.match && basis && food.grams !== null) {
    const note = `${food.quantity} ${food.unit} ≈ ${Math.round(food.grams)} g (AI portion estimate)`;
    return buildItem(food, result.match.food, basis, { grams: food.grams, source: "default", note });
  }

  return {
    id: null,
    food_name: food.name,
    quantity: food.quantity,
    unit: food.unit,
    grams: food.grams,
    basis_per_100g: null,
    macros: { ...food.estimated_macros },
    nutrition_source: "ai",
    source_reference: null,
    inferred: food.inferred,
    confidence: food.confidence,
    edited_by_user: false,
    assumptions: [AI_ONLY_REASON[result.reason], food.notes?.trim() || null]
      .filter(Boolean)
      .join("; ")
      .slice(0, MAX_ASSUMPTIONS_LENGTH),
  };
}

// How far past the threshold an item's uncertainty goes; > 1 means ask.
function uncertainty(food: ExtractedFood, totals: Macros): number {
  const range = food.estimate_range;
  const calorieSpan = Math.abs(range.calories_high - range.calories_low);
  const proteinSpan = Math.abs(range.protein_g_high - range.protein_g_low);
  const calorieLimit = CLARIFY_CALORIE_SHARE * totals.calories;
  const calorieRatio = calorieLimit > 0 ? calorieSpan / calorieLimit : calorieSpan > 0 ? Infinity : 0;
  return Math.max(calorieRatio, proteinSpan / CLARIFY_PROTEIN_G);
}

// The rule decides, not the model's own flag, so the result is deterministic and testable. The
// model's question is kept when it asked one; otherwise ask about the most uncertain item.
export function clarification(
  meal: Pick<ExtractedMeal, "foods" | "clarification_question">,
  totals: Macros,
): Pick<MealProposal, "needs_clarification" | "clarification_question"> {
  let worst: { food: ExtractedFood; score: number } | null = null;
  for (const food of meal.foods) {
    const score = uncertainty(food, totals);
    if (score > 1 && (!worst || score > worst.score)) worst = { food, score };
  }
  if (!worst) return { needs_clarification: false, clarification_question: null };

  const name = worst.food.name.toLowerCase();
  const question =
    meal.clarification_question?.trim() ||
    (worst.food.inferred ? `Did it have ${name}, and about how much?` : `About how much ${name} did you have?`);
  return { needs_clarification: true, clarification_question: question };
}
