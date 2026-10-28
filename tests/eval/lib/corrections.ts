import { randomUUID } from "node:crypto";
import { formatInTimeZone } from "date-fns-tz";
import type { ChatMessage, Meal, MealItem, UpdateMealRequest } from "@/types/api";
import { runChatTurn } from "@/lib/ai/chat";
import { buildContext, loadRecentMeals } from "@/lib/ai/context";
import { createMealStore } from "@/lib/ai/meal-store";
import type { AIProvider, ChatInput, ProviderTurn, ToolCall } from "@/lib/ai/provider";
import type { RecordUsage } from "@/lib/ai/usage";
import type { ToolContext, TurnState } from "@/lib/ai/tools";
import { SKIM_MILK } from "@/lib/ai/__fixtures__/foods";
import { createFakeDb, fakeClient } from "@/lib/database/__fixtures__/fake-db";
import { findMeal } from "@/lib/database/meals";
import type { NutritionLookup } from "@/lib/nutrition/usda";
import type { CorrectionCase } from "./cases";

// B10 correction eval harness (tests/eval/correction-cases.jsonl). Each case's fixture meals are seeded
// into the in-memory Supabase (src/lib/database/__fixtures__/fake-db.ts, RLS and the meal SQL functions
// emulated) for one test user, then the message runs through the real chat turn: buildContext() with
// the recent meals, runChatTurn(), the real tools, and createMealStore() on top of B7's meal writes.
// Only the model is swapped: lib/correction-cases.test.ts scripts it (CI, no keys), and
// run-corrections.ts uses a real provider (opt-in, paid). checkCorrection() then compares the saved
// meals with the case's expectation. No vitest imports here, so the live runner can use it.

export const EVAL_USER = "11111111-1111-4111-8111-111111111111";

// --- Nutrition lookup -----------------------------------------------------------------------------

// The only food swap in the cases is whole → skim milk. Every search returns the fixed list; B5's
// matcher ranks and rejects it as it would real results.
export const correctionLookup: NutritionLookup = {
  searchFoods: async () => [{ ...SKIM_MILK, portions: [] }],
  getFood: async (fdcId) => (fdcId === SKIM_MILK.fdcId ? SKIM_MILK : null),
};

// --- Seeding --------------------------------------------------------------------------------------

const n3 = (value: number) => Math.round(value * 1000) / 1000;

export interface SeededCase {
  db: ReturnType<typeof createFakeDb>;
  mealIds: Map<string, string>; // fixture label → UUID
  itemIds: Map<string, string>; // "<meal label>/<item label>" → UUID
}

// Items get a USDA-style basis (macros × 100 / grams), stored to numeric(10,3) like the database,
// so recalculating an untouched item reproduces it.
export function seedCorrectionCase(testCase: CorrectionCase): SeededCase {
  const db = createFakeDb();
  db.profiles.push({ id: EVAL_USER, timezone: testCase.timezone });
  const mealIds = new Map<string, string>();
  const itemIds = new Map<string, string>();
  for (const meal of testCase.recent_meals) {
    const id = randomUUID();
    mealIds.set(meal.id, id);
    const items = meal.items.map((item, position) => {
      const basis = {
        calories: n3((item.macros.calories * 100) / item.grams),
        protein_g: n3((item.macros.protein_g * 100) / item.grams),
        carbs_g: n3((item.macros.carbs_g * 100) / item.grams),
        fat_g: n3((item.macros.fat_g * 100) / item.grams),
      };
      const itemId = randomUUID();
      itemIds.set(`${meal.id}/${item.id}`, itemId);
      return {
        id: itemId,
        meal_id: id,
        position,
        food_name: item.name,
        quantity: item.quantity,
        unit: item.unit,
        grams: item.grams,
        basis_per_100g: basis,
        calories: n3((basis.calories * item.grams) / 100),
        protein_g: n3((basis.protein_g * item.grams) / 100),
        carbs_g: n3((basis.carbs_g * item.grams) / 100),
        fat_g: n3((basis.fat_g * item.grams) / 100),
        nutrition_source: "usda" as const,
        source_reference: null,
        inferred: false,
        confidence: "high" as const,
        edited_by_user: false,
        assumptions: null,
      };
    });
    const iso = new Date(meal.consumed_at).toISOString();
    const sum = (key: "calories" | "protein_g" | "carbs_g" | "fat_g") => n3(items.reduce((total, item) => total + item[key], 0));
    db.meals.push({
      id,
      user_id: EVAL_USER,
      name: meal.name,
      consumed_at: iso,
      created_at: iso,
      updated_at: iso,
      source_type: "text",
      total_calories: sum("calories"),
      total_protein_g: sum("protein_g"),
      total_carbs_g: sum("carbs_g"),
      total_fat_g: sum("fat_g"),
      status: "active",
      deleted_at: null,
      version: meal.version,
    });
    db.meal_items.push(...items);
  }
  return { db, mealIds, itemIds };
}

// Earlier turns as stored messages. An assistant turn that names a fixture meal carries its meal card,
// as a real reply that saved it would.
function historyFor(testCase: CorrectionCase, meals: ReadonlyMap<string, Meal>, now: Date): ChatMessage[] {
  return testCase.recent_messages.map((message, i) => ({
    id: randomUUID(),
    client_message_id: null,
    role: message.role,
    text: message.text,
    cards:
      message.role === "assistant"
        ? testCase.recent_meals
            .filter((fixture) => message.text.includes(fixture.name))
            .map((fixture) => {
              const meal = meals.get(fixture.id)!;
              return { kind: "meal" as const, meal_id: meal.id, meal };
            })
        : [],
    had_image: false,
    status: "sent" as const,
    created_at: new Date(now.getTime() - (testCase.recent_messages.length - i) * 60_000).toISOString(),
  }));
}

// --- Running a case -------------------------------------------------------------------------------

export interface CorrectionOutcome {
  text: string;
  state: TurnState;
  context: string;                 // the context block the model saw
  toolCalls: ToolCall[];           // every call the model made, in order
  toolOutputs: unknown[];          // what each call returned, in order
  updatePatches: UpdateMealRequest[]; // what update_meal sent to the meal store
  before: Map<string, Meal>;       // fixture label → meal as seeded
  after: Map<string, Meal | null>; // fixture label → meal after the turn (null if gone)
}

export async function runCorrectionCase(
  testCase: CorrectionCase,
  provider: AIProvider,
  options: { recordUsage?: RecordUsage } = {},
): Promise<CorrectionOutcome & SeededCase> {
  const seeded = seedCorrectionCase(testCase);
  const supabase = fakeClient(seeded.db, { userId: EVAL_USER });
  const now = new Date(testCase.now);
  const timezone = testCase.timezone;
  const readAll = async () => {
    const meals = new Map<string, Meal | null>();
    for (const [label, id] of seeded.mealIds) meals.set(label, await findMeal(supabase, EVAL_USER, id));
    return meals;
  };
  const before = new Map([...(await readAll())].map(([label, meal]) => [label, meal!]));

  const store = createMealStore(supabase, EVAL_USER, timezone, () => now);
  const updatePatches: UpdateMealRequest[] = [];
  const updateMeal = store.updateMeal;
  store.updateMeal = (mealId, patch) => {
    updatePatches.push(structuredClone(patch));
    return updateMeal(mealId, patch);
  };

  // What the chat route loads before the model call.
  const [recentMeals, today] = await Promise.all([loadRecentMeals(store), store.dailySummary()]);
  const chat = buildContext({
    now,
    timezone,
    preferences: { save_mode: "confirm", assistant_style: "casual" },
    history: historyFor(testCase, before, now),
    today,
    recentMeals,
    memories: [],
    message: { text: testCase.input, hasImage: false },
  });

  const toolCalls: ToolCall[] = [];
  const toolOutputs: unknown[] = [];
  const recording: AIProvider = {
    name: provider.name,
    model: provider.model,
    extractMeal: (input) => provider.extractMeal(input),
    async chat(input) {
      const last = input.messages.at(-1);
      if (last?.role === "tool") toolOutputs.push(...last.results.map((result) => result.output));
      const turn = await provider.chat(input);
      toolCalls.push(...turn.toolCalls);
      return turn;
    },
  };

  const tools: ToolContext = {
    userId: EVAL_USER,
    supabase,
    now,
    timezone,
    saveMode: "confirm",
    analyze: async () => {
      throw new Error("a correction must not re-extract the meal");
    },
    lookup: correctionLookup,
    meals: store,
    memory: null,
    priorProposals: new Map(),
  };
  const result = await runChatTurn(chat, tools, { provider: recording, recordUsage: options.recordUsage ?? (async () => {}) });
  return {
    ...seeded,
    text: result.text,
    state: result.state,
    context: chat.context,
    toolCalls,
    toolOutputs,
    updatePatches,
    before,
    after: await readAll(),
  };
}

// --- Scripted model (CI) ----------------------------------------------------------------------------

// The tool call a good model makes for each case. Meal IDs and versions are read from the context
// block the model is given (so the case also checks B10's context lists them), never from the fixture.
export type ScriptedCall = { name: "update_meal" | "delete_meal"; meal?: string; input: Record<string, unknown> };

export const SCRIPTED_CALLS: Record<string, ScriptedCall> = {
  // Same call as c08: the tool finds the one recent meal with cheese.
  "c01-remove-the-cheese": { name: "update_meal", input: { item_changes: [{ food_name: "cheese", remove: true }] } },
  "c02-only-ate-half": { name: "update_meal", meal: "m-pizza", input: { scale: 0.5 } },
  "c03-that-was-lunch-yesterday": { name: "update_meal", meal: "m-bowl", input: { time_phrase: "lunch yesterday" } },
  "c04-two-eggs-not-three": { name: "update_meal", meal: "m-eggs", input: { item_changes: [{ food_name: "eggs", quantity: 2 }] } },
  "c05-200g-not-150g": { name: "update_meal", meal: "m-chicken-rice", input: { item_changes: [{ food_name: "chicken", grams: 200 }] } },
  "c06-actually-skim-milk": {
    name: "update_meal",
    meal: "m-cereal",
    input: { item_changes: [{ food_name: "milk", replace_with: "skim milk", search_query: "milk, nonfat, fluid" }] },
  },
  "c07-delete-last-meal": { name: "delete_meal", meal: "m-cookies", input: {} },
  // The user didn't say which meal: leave meal_id out and let update_meal check (PRD 12.5).
  "c08-ambiguous-remove-cheese": { name: "update_meal", input: { item_changes: [{ food_name: "cheese", remove: true }] } },
};

const RECENT_LINE = /^- ([0-9a-f-]{36}) \| v(\d+) \| [^|]+ \| (.+?) \| /;

// meal_id and version for a fixture meal, as the context block lists them.
export function fromContext(context: string, mealName: string): { meal_id: string; version: number } | null {
  for (const line of context.split("\n")) {
    const match = RECENT_LINE.exec(line);
    if (match && match[3] === mealName) return { meal_id: match[1]!, version: Number(match[2]) };
  }
  return null;
}

const turn = (partial: Partial<ProviderTurn>): ProviderTurn => ({
  text: "",
  toolCalls: [],
  stopReason: "end",
  usage: { inputTokens: 0, outputTokens: 0 },
  model: "scripted",
  ...partial,
});

// Call 1: the scripted tool call. Call 2: a reply built from the tool result (a question when the tool
// asked for clarification), like a model following the chat prompt.
export function scriptedProvider(testCase: CorrectionCase, override?: ScriptedCall): AIProvider {
  const script = override ?? SCRIPTED_CALLS[testCase.id];
  if (!script) throw new Error(`No scripted call for ${testCase.id}`);
  let step = 0;
  return {
    name: "anthropic",
    model: "scripted",
    extractMeal: async () => {
      throw new Error("not used");
    },
    async chat(input: ChatInput) {
      step += 1;
      if (step === 1) {
        let target = {};
        if (script.meal) {
          const name = testCase.recent_meals.find((meal) => meal.id === script.meal)!.name;
          const seen = fromContext(input.context ?? "", name);
          if (!seen) return turn({ text: `I can't find ${name} in the context.` });
          target = script.name === "delete_meal" ? { meal_id: seen.meal_id } : seen;
        }
        const call: ToolCall = { id: `call_${testCase.id}`, name: script.name, input: { ...target, ...script.input } };
        return turn({ toolCalls: [call], stopReason: "tool_calls" });
      }
      const last = input.messages.at(-1);
      const output = (last?.role === "tool" ? last.results[0]?.output : null) as
        | { status?: string; candidates?: Array<{ name: string }>; error?: string }
        | null;
      if (output?.status === "needs_clarification") {
        return turn({ text: `Which one: ${output.candidates!.map((c) => c.name).join(" or ")}?` });
      }
      if (output?.error) return turn({ text: `That didn't go through: ${output.error}` });
      return turn({ text: output?.status === "deleted" ? "Deleted." : "Updated." });
    },
  };
}

// --- Scoring --------------------------------------------------------------------------------------

const GRAMS_TOLERANCE = 0.05;

function within(actual: number | null, expected: number, tolerance = GRAMS_TOLERANCE): boolean {
  return actual !== null && Math.abs(actual - expected) <= Math.abs(expected) * tolerance;
}

function sameItem(a: MealItem, b: MealItem): boolean {
  return (
    a.food_name === b.food_name &&
    a.quantity === b.quantity &&
    a.unit === b.unit &&
    a.grams === b.grams &&
    Math.abs(a.macros.calories - b.macros.calories) < 0.01 &&
    Math.abs(a.macros.protein_g - b.macros.protein_g) < 0.01
  );
}

function sameMeal(a: Meal, b: Meal | null): boolean {
  return (
    b !== null &&
    b.status === a.status &&
    b.version === a.version &&
    b.name === a.name &&
    b.consumed_at === a.consumed_at &&
    b.items.length === a.items.length &&
    a.items.every((item, i) => sameItem(item, b.items[i]!))
  );
}

const ok = (outcome: CorrectionOutcome, name: string) =>
  outcome.state.tools.filter((t) => t.name === name && t.ok).length;

// Every way the outcome differs from the case's expectation; empty means the case passes.
export function checkCorrection(testCase: CorrectionCase, outcome: CorrectionOutcome & SeededCase): string[] {
  const problems: string[] = [];
  const expected = testCase.expected;
  const others = (target: string | null) => {
    for (const [label, meal] of outcome.before) {
      if (label !== target && !sameMeal(meal, outcome.after.get(label) ?? null)) problems.push(`${label} changed but shouldn't have`);
    }
  };

  if (expected.kind === "clarification") {
    if (outcome.updatePatches.length > 0) problems.push("update_meal wrote a change; it should have asked");
    if (ok(outcome, "delete_meal") > 0) problems.push("a meal was deleted; it should have asked");
    others(null);
    const asked = outcome.toolOutputs.find(
      (o): o is { status: string; candidates: Array<{ meal_id: string }> } =>
        typeof o === "object" && o !== null && (o as { status?: string }).status === "needs_clarification",
    );
    const want = expected.candidate_meal_ids.map((label) => outcome.mealIds.get(label)).sort();
    if (asked) {
      const got = asked.candidates.map((c) => c.meal_id).sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`candidates ${got.join(",")} ≠ ${want.join(",")}`);
    }
    if (!outcome.text.includes("?")) problems.push(`the reply doesn't ask a question: "${outcome.text}"`);
    return problems;
  }

  const id = outcome.mealIds.get(expected.meal_id)!;
  const before = outcome.before.get(expected.meal_id)!;
  const after = outcome.after.get(expected.meal_id) ?? null;
  others(expected.meal_id);

  if (expected.kind === "delete") {
    if (ok(outcome, "delete_meal") !== 1) problems.push(`expected one successful delete_meal, got ${ok(outcome, "delete_meal")}`);
    if (outcome.updatePatches.length > 0) problems.push("update_meal was called");
    const deleted = outcome.toolCalls.find((c) => c.name === "delete_meal");
    if (deleted && (deleted.input as { meal_id?: string }).meal_id !== id) problems.push("delete_meal targeted the wrong meal");
    if (after && after.status !== "pending_deletion") problems.push(`${expected.meal_id} is still ${after.status}`);
    return problems;
  }

  if (ok(outcome, "update_meal") !== 1 || outcome.updatePatches.length !== 1) {
    problems.push(`expected one successful update_meal, got ${ok(outcome, "update_meal")} (${outcome.updatePatches.length} writes)`);
  }
  if (ok(outcome, "delete_meal") > 0) problems.push("delete_meal was called");
  const patch = outcome.updatePatches[0];
  if (patch && patch.version !== expected.version) problems.push(`update_meal sent version ${patch.version}, expected ${expected.version}`);
  if (!after || after.status !== "active") return [...problems, `${expected.meal_id} is gone after the update`];
  if (patch && after.version !== expected.version + 1) problems.push(`version is ${after.version}, expected ${expected.version + 1}`);

  const itemId = (label: string) => outcome.itemIds.get(`${expected.meal_id}/${label}`)!;
  const beforeItem = (label: string) => before.items.find((item) => item.id === itemId(label));
  const afterItem = (label: string) => after.items.find((item) => item.id === itemId(label));
  const touched = new Set<string>();

  for (const label of expected.removed_items ?? []) {
    touched.add(label);
    if (afterItem(label)) problems.push(`${label} wasn't removed`);
  }
  for (const [label, grams] of Object.entries(expected.item_grams ?? {})) {
    touched.add(label);
    const item = afterItem(label);
    if (!item || !within(item.grams, grams)) problems.push(`${label} is ${item?.grams ?? "missing"} g, expected ${grams} g`);
  }
  for (const [label, quantity] of Object.entries(expected.item_quantity ?? {})) {
    touched.add(label);
    const item = afterItem(label);
    if (!item || !within(item.quantity, quantity, 0)) problems.push(`${label} quantity is ${item?.quantity ?? "missing"}, expected ${quantity}`);
  }
  for (const [label, keywords] of Object.entries(expected.item_renamed ?? {})) {
    touched.add(label);
    const name = afterItem(label)?.food_name.toLowerCase() ?? "";
    if (!keywords.some((word) => name.includes(word))) problems.push(`${label} is "${name}", expected one of ${keywords.join(", ")}`);
  }
  if (expected.scale_all !== undefined) {
    for (const item of before.items) {
      const now = after.items.find((i) => i.id === item.id);
      if (!now || !within(now.grams, item.grams! * expected.scale_all)) {
        problems.push(`${item.food_name} is ${now?.grams ?? "missing"} g, expected ${item.grams! * expected.scale_all} g`);
      }
    }
  } else {
    // Items the expectation doesn't mention stay exactly as they were.
    for (const fixture of testCase.recent_meals.find((m) => m.id === expected.meal_id)!.items) {
      if (touched.has(fixture.id)) continue;
      const was = beforeItem(fixture.id)!;
      const now = afterItem(fixture.id);
      if (!now || !sameItem(was, now)) problems.push(`${fixture.id} changed but shouldn't have`);
    }
  }
  if (after.items.length !== before.items.length - (expected.removed_items?.length ?? 0)) {
    problems.push(`${after.items.length} items after, expected ${before.items.length - (expected.removed_items?.length ?? 0)}`);
  }

  if (expected.consumed_local_date) {
    const local = formatInTimeZone(new Date(after.consumed_at), testCase.timezone, "yyyy-MM-dd");
    if (local !== expected.consumed_local_date) problems.push(`consumed on ${local}, expected ${expected.consumed_local_date}`);
    if (expected.consumed_local_hours) {
      const hour = Number(formatInTimeZone(new Date(after.consumed_at), testCase.timezone, "H"));
      const [from, to] = expected.consumed_local_hours;
      if (hour < from || hour >= to) problems.push(`consumed at hour ${hour}, expected [${from}, ${to})`);
    }
  } else if (after.consumed_at !== before.consumed_at) {
    problems.push(`consumed_at moved from ${before.consumed_at} to ${after.consumed_at}`);
  }

  if (expected.totals) {
    const delta = after.totals.calories - before.totals.calories;
    const direction = Math.abs(delta) < 0.5 ? "same" : delta < 0 ? "down" : "up";
    if (direction !== expected.totals.calories) problems.push(`calories went ${direction}, expected ${expected.totals.calories}`);
  }
  return problems;
}
