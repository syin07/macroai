import { vi, type Mock } from "vitest";
import type { NutritionLookup, UsdaFood } from "@/lib/nutrition/usda";
import type { ExtractedFood, ExtractedMeal, ExtractionResult } from "../extraction";
import type { AIProvider, ChatInput, ExtractMealInput, ProviderTurn, ToolCall } from "../provider";

// Test doubles for the chat pipeline. No network: the "model" follows a script.

const USAGE = { inputTokens: 1000, outputTokens: 50 };
export const FAKE_MODEL = "claude-haiku-5-5";

export type ScriptStep = Partial<ProviderTurn> | ((input: ChatInput) => Partial<ProviderTurn>);

export function say(text: string): Partial<ProviderTurn> {
  return { text, toolCalls: [], stopReason: "end" };
}

let callSeq = 0;
export function callTool(name: string, input: unknown, text = ""): Partial<ProviderTurn> {
  const call: ToolCall = { id: `call_${++callSeq}`, name, input };
  return { text, toolCalls: [call], stopReason: "tool_calls" };
}

export type FakeProvider = AIProvider & {
  chatInputs: ChatInput[];
  extractInputs: ExtractMealInput[];
  chat: Mock<AIProvider["chat"]>;
  extractMeal: Mock<AIProvider["extractMeal"]>;
};

// `script` is consumed one step per chat() call; once it runs out the model says "Done.".
// `extractions` is consumed one per extractMeal() call.
export function fakeProvider(script: ScriptStep[] = [], extractions: ExtractionResult[] = []): FakeProvider {
  const steps = [...script];
  const results = [...extractions];
  const chatInputs: ChatInput[] = [];
  const extractInputs: ExtractMealInput[] = [];
  const provider = {
    name: "anthropic" as const,
    model: FAKE_MODEL,
    chatInputs,
    extractInputs,
    chat: vi.fn(async (input: ChatInput): Promise<ProviderTurn> => {
      chatInputs.push(structuredClone(input));
      const step = steps.shift() ?? say("Done.");
      const turn = typeof step === "function" ? step(input) : step;
      return { text: "", toolCalls: [], stopReason: "end", usage: USAGE, model: FAKE_MODEL, ...turn };
    }),
    extractMeal: vi.fn(async (input: ExtractMealInput) => {
      extractInputs.push(input);
      const result = results.shift();
      if (!result) throw new Error("fakeProvider: no extraction scripted");
      return { result, usage: USAGE, model: FAKE_MODEL, promptVersion: "test" };
    }),
  };
  return provider as unknown as FakeProvider;
}

// The tool results the model would see on this call (from the last "tool" message).
export function lastToolOutputs(input: ChatInput): unknown[] {
  const last = input.messages.at(-1);
  return last?.role === "tool" ? last.results.map((r) => r.output) : [];
}

// --- Nutrition lookup -----------------------------------------------------------------------------

export { SKIM_MILK } from "./foods";

// A USDA stand-in with a fixed food list: every search returns all of them, and B5's matcher ranks
// and rejects them exactly as it does real results.
export function fakeLookup(foods: readonly UsdaFood[]): NutritionLookup {
  return {
    searchFoods: vi.fn(async () => foods.map((food) => ({ ...food, portions: [] }))),
    getFood: vi.fn(async (fdcId: number) => foods.find((food) => food.fdcId === fdcId) ?? null),
  };
}

// --- Extraction builders --------------------------------------------------------------------------

export function food(name: string, calories: number, protein_g: number, grams: number, extra: Partial<ExtractedFood> = {}): ExtractedFood {
  return {
    name,
    brand: null,
    quantity: grams,
    unit: "g",
    grams,
    preparation: null,
    estimated_quantity: false,
    inferred: false,
    confidence: "high",
    search_query: name.toLowerCase(),
    estimated_macros: { calories, protein_g, carbs_g: 10, fat_g: 5 },
    // Tight range: no clarification under the FR-03 rule.
    estimate_range: { calories_low: calories * 0.95, calories_high: calories * 1.05, protein_g_low: protein_g, protein_g_high: protein_g + 1 },
    notes: null,
    ...extra,
  };
}

export function meal(name: string, foods: ExtractedFood[], extra: Partial<ExtractedMeal> = {}): ExtractedMeal {
  return { name, consumed_at: null, time_phrase: null, foods, needs_clarification: false, clarification_question: null, ...extra };
}

export function logged(...meals: ExtractedMeal[]): ExtractionResult {
  return { intent: "log_meal", meals, explanation: null };
}

export function question(explanation: string): ExtractionResult {
  return { intent: "question", meals: [], explanation };
}

export const EGGS_AND_TOAST = meal("Eggs and Toast", [food("Eggs", 155, 12.6, 100), food("Toast", 80, 3, 30)]);

// A vague burger: the calorie range is wide enough that FR-03 asks a question.
export const VAGUE_BURGER = meal("Burger", [
  food("Burger", 600, 30, 220, {
    confidence: "low",
    estimated_quantity: true,
    estimate_range: { calories_low: 350, calories_high: 1000, protein_g_low: 20, protein_g_high: 45 },
  }),
]);
