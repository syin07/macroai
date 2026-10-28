import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type {
  DailySummary,
  Macros,
  Meal,
  MealCard,
  MealItem,
  MealProposal,
  MealSourceType,
  Memory,
  Preferences,
  UpdateMealRequest,
} from "@/types/api";
import { ApiErrorException } from "@/lib/api-error";
import { getGoalsOn } from "@/lib/database/goals";
import type { LastMealMatch, MealHistoryResult, SearchMealHistoryOptions } from "@/lib/database/history";
import { localDate } from "@/lib/database/profile";
import { itemMacros, resizeItem } from "@/lib/nutrition/calc";
import { matchFood } from "@/lib/nutrition/match";
import type { NutritionLookup } from "@/lib/nutrition/usda";
import { isoDate, isoDateTime, text, uuid } from "@/lib/validation/common";
import { memorySchema } from "@/lib/validation/account";
import type { SaveStatedMemoryResult } from "@/lib/memory/extract";
import type { MealAnalysis } from "./analyze";
import { inUserZone, parseTimePhrase } from "./dates";
import type { MealImage, ToolCall, ToolDef, ToolResult } from "./provider";

// The chat model's tools (PRD §5.7). Each one is a plain server function: the model supplies
// arguments, Zod validates them, and the code acts for the session user carried in ToolContext. No
// argument names a user, so the model can't reach anyone else's data, and every write goes through
// the meal store (B7's validated functions), never straight to a table.
//
// Nothing the model sends is trusted for nutrition: save_meal takes only a proposal ID and saves the
// server's own copy of that proposal; update_meal takes amounts and recalculates with calc.ts.

// --- Dependencies ---------------------------------------------------------------------------------

// The session's zone and clock, for anything that turns local dates into instants.
export interface SessionClock {
  timezone: string;
  now: Date;
}

// How many of the newest meals the context shows and update_meal considers when the model doesn't name
// one (plan B10).
export const RECENT_MEALS = 5;

// B7's meal functions, bound to the session user. See createMealStore() in ./meal-store.
export interface MealStore {
  saveProposal(proposal: MealProposal, sourceType: MealSourceType): Promise<Meal>; // idempotent on proposal_id
  getMeal(mealId: string): Promise<Meal | null>;
  getMeals(mealIds: string[]): Promise<Map<string, Meal>>;
  updateMeal(mealId: string, patch: UpdateMealRequest): Promise<Meal>;
  deleteMeal(mealId: string): Promise<{ undo_until: string }>;
  dailySummary(date?: string): Promise<DailySummary>; // today in the user's zone when omitted
  recentMeals(limit: number): Promise<Meal[]>; // active meals, newest consumed first, with items
  // B11 (database/history.ts): searchMealHistory() and findLastMealMatching().
  searchHistory(options: Omit<SearchMealHistoryOptions, "timezone">, session: SessionClock): Promise<MealHistoryResult>;
  lastMatching(options: { q: string; before?: string }, session: SessionClock): Promise<LastMealMatch | null>;
}

// B13's memory functions, bound to the session user and this turn's message. See createMemoryStore()
// in ./memory-store.
export interface MemoryStore {
  search(query: string): Promise<Memory[]>;
  // Saves only when `evidence` is quoted from the user's own message this turn (else "not_stated").
  save(memory: Pick<Memory, "category" | "content"> & { evidence: string }): Promise<SaveStatedMemoryResult>;
  remove(memoryId: string): Promise<boolean>; // soft delete; false if there was no such live memory
}

export interface ToolContext {
  userId: string;           // the session user; never from the model
  supabase: SupabaseClient; // the user's RLS-bound client
  now: Date;
  timezone: string;
  saveMode: Preferences["save_mode"];
  image?: MealImage;        // the current message's photo, handed to extraction only
  analyze: (input: { text?: string; image?: MealImage }) => Promise<MealAnalysis>;
  lookup: NutritionLookup;
  meals: MealStore | null;   // null until B7 is wired: meal tools are then not offered
  memory: MemoryStore | null; // null until B13 is wired: memory tools are then not offered
  // Unsaved proposals from recent assistant messages, by proposal_id, so "save that" can work.
  priorProposals: ReadonlyMap<string, MealProposal>;
}

// What this turn did; the chat route turns it into the assistant message's cards.
export interface TurnState {
  cards: MealCard[];
  proposals: Map<string, MealProposal>; // created this turn
  meals: Map<string, Meal>;             // saved or updated this turn, latest version
  mealChanged: boolean;                 // a meal was created, updated, or deleted
  relatedMealId: string | null;
  tools: Array<{ name: string; ok: boolean }>;
}

export function newTurnState(): TurnState {
  return { cards: [], proposals: new Map(), meals: new Map(), mealChanged: false, relatedMealId: null, tools: [] };
}

// --- Output shaping (what the model reads) --------------------------------------------------------

const r = (value: number) => Math.round(value);
const roundMacros = (m: Macros) => ({ calories: r(m.calories), protein_g: r(m.protein_g), carbs_g: r(m.carbs_g), fat_g: r(m.fat_g) });

function itemSummary(item: Pick<MealItem, "id" | "food_name" | "quantity" | "unit" | "grams" | "macros">) {
  return {
    ...(item.id ? { item_id: item.id } : {}),
    food_name: item.food_name,
    quantity: Math.round(item.quantity * 100) / 100,
    unit: item.unit,
    grams: item.grams === null ? null : r(item.grams),
    calories: r(item.macros.calories),
    protein_g: r(item.macros.protein_g),
  };
}

function mealSummary(meal: Meal) {
  return {
    meal_id: meal.id,
    version: meal.version,
    name: meal.name,
    consumed_at: meal.consumed_at,
    totals: roundMacros(meal.totals),
    items: meal.items.map(itemSummary),
  };
}

function proposalSummary(proposal: MealProposal) {
  return {
    proposal_id: proposal.proposal_id,
    name: proposal.name,
    consumed_at: proposal.consumed_at,
    totals: roundMacros(proposal.totals),
    items: proposal.items.map(itemSummary),
    needs_clarification: proposal.needs_clarification,
    clarification_question: proposal.clarification_question,
  };
}

// --- Card bookkeeping -----------------------------------------------------------------------------

function putMealCard(state: TurnState, meal: Meal, replacesProposalId?: string) {
  state.meals.set(meal.id, meal);
  state.mealChanged = true;
  state.relatedMealId ??= meal.id;
  const card: MealCard = { kind: "meal", meal_id: meal.id, meal };
  const index = state.cards.findIndex(
    (c) =>
      (c.kind === "meal" && c.meal_id === meal.id) ||
      (replacesProposalId !== undefined && c.kind === "proposal" && c.proposal.proposal_id === replacesProposalId),
  );
  if (index === -1) state.cards.push(card);
  else state.cards[index] = card;
}

// --- Tool definitions -----------------------------------------------------------------------------

// A failure the model should see and explain (bad target, nothing to change). Not logged. `details`
// go into the error result next to the message (e.g. the current meal after a version conflict).
export class ToolInputError extends Error {
  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ToolInputError";
  }
}

interface ToolSpec<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  needs?: "meals" | "memory";
  run: (args: z.output<S>, ctx: ToolContext, state: TurnState) => Promise<unknown>;
}

function tool<S extends z.ZodType>(spec: ToolSpec<S>): ToolSpec<S> {
  return spec;
}

function requireMeals(ctx: ToolContext): MealStore {
  if (!ctx.meals) throw new ToolInputError("Meal records aren't available right now.");
  return ctx.meals;
}

function requireMemory(ctx: ToolContext): MemoryStore {
  if (!ctx.memory) throw new ToolInputError("Memories aren't available right now.");
  return ctx.memory;
}

async function saveProposal(ctx: ToolContext, state: TurnState, proposal: MealProposal): Promise<Meal> {
  const meal = await requireMeals(ctx).saveProposal(proposal, ctx.image ? "photo" : "text");
  putMealCard(state, meal, proposal.proposal_id);
  return meal;
}

const searchNutritionFoods = tool({
  name: "search_nutrition_foods",
  description:
    "Search USDA FoodData Central for a food. Returns candidates with macros per 100 g. Use for nutrition questions, not for logging.",
  schema: z.strictObject({
    query: text(200).describe("Generic food name, e.g. 'salmon, atlantic, cooked'."),
    limit: z.number().int().min(1).max(10).default(5),
  }),
  async run(args, ctx) {
    const foods = await ctx.lookup.searchFoods(args.query);
    return {
      foods: foods
        .filter((food) => food.basis_per_100g !== null)
        .slice(0, args.limit)
        .map((food) => ({
          fdc_id: food.fdcId,
          description: food.description,
          brand: food.brand,
          per_100g: roundMacros(food.basis_per_100g!),
        })),
    };
  },
});

const getFoodNutrition = tool({
  name: "get_food_nutrition",
  description: "Get one USDA food's macros per 100 g and its common portions, by fdc_id from search_nutrition_foods.",
  schema: z.strictObject({ fdc_id: z.number().int().positive() }),
  async run(args, ctx) {
    const food = await ctx.lookup.getFood(args.fdc_id);
    if (!food || !food.basis_per_100g) throw new ToolInputError("No usable nutrition data for that food.");
    return {
      fdc_id: food.fdcId,
      description: food.description,
      brand: food.brand,
      per_100g: roundMacros(food.basis_per_100g),
      portions: food.portions.slice(0, 8).map((p) => ({ amount: p.amount, unit: p.unit, grams: p.gramWeight })),
    };
  },
});

export const MAX_PROPOSAL_CALLS = 2;

const createMealProposal = tool({
  name: "create_meal_proposal",
  description:
    "Turn food the user actually ate into meal proposals with calculated nutrition. Pass the user's own words for all the food in the message (amounts, brands, time words). In confirm mode the proposals stay unsaved for the user to review; in auto mode clear meals are saved and reported as status 'saved'. Never use for hypotheticals or questions.",
  schema: z.strictObject({
    description: text(2000).describe("The food the user ate, in their words, e.g. '2 eggs and toast for breakfast'."),
  }),
  async run(args, ctx, state) {
    // Each call is a second model call (extraction); one per message is normal, two is the ceiling.
    const previousCalls = state.tools.filter((t) => t.name === "create_meal_proposal").length;
    if (previousCalls >= MAX_PROPOSAL_CALLS) {
      throw new ToolInputError("Already analyzed this message. Use the proposals you have.");
    }
    const analysis = await ctx.analyze({ text: args.description, image: ctx.image });
    if (analysis.proposals.length === 0) {
      return { intent: analysis.intent, proposals: [], explanation: analysis.explanation, saved: false };
    }

    const results = [];
    for (const proposal of analysis.proposals) {
      state.proposals.set(proposal.proposal_id, proposal);
      // FR-08: auto mode saves what's clear and asks about the rest.
      if (ctx.saveMode === "auto" && !proposal.needs_clarification && ctx.meals) {
        const meal = await saveProposal(ctx, state, proposal);
        results.push({ status: "saved", ...mealSummary(meal) });
        continue;
      }
      state.cards.push({ kind: "proposal", state: "unsaved", proposal });
      results.push({
        status: proposal.needs_clarification ? "needs_clarification" : "unsaved_awaiting_user",
        ...proposalSummary(proposal),
      });
    }
    return { intent: analysis.intent, proposals: results, explanation: analysis.explanation };
  },
});

const saveMeal = tool({
  name: "save_meal",
  description:
    "Save an unsaved meal proposal, by proposal_id, when the user explicitly asks to save it. Saves the server's copy of the proposal; retrying never duplicates it.",
  schema: z.strictObject({ proposal_id: uuid }),
  needs: "meals",
  async run(args, ctx, state) {
    const current = state.proposals.get(args.proposal_id);
    if (current && ctx.saveMode === "confirm") {
      // FR-08 confirm mode: a proposal made in this turn waits for the user, not the model.
      throw new ToolInputError("The user hasn't confirmed this proposal yet. It's shown as a card they can save.");
    }
    const proposal = current ?? ctx.priorProposals.get(args.proposal_id);
    if (!proposal) throw new ToolInputError("No unsaved proposal with that ID.");
    const meal = await saveProposal(ctx, state, proposal);
    return { status: "saved", ...mealSummary(meal) };
  },
});

const itemChangeSchema = z
  .strictObject({
    item_id: uuid.optional(),
    food_name: text(200).optional().describe("Finds the item, e.g. 'cheese'."),
    quantity: z.number().finite().positive().max(10_000).optional().describe("In the item's unit."),
    grams: z.number().finite().positive().max(10_000).optional(),
    remove: z.boolean().optional(),
    replace_with: text(200).optional().describe("Swap to another food, e.g. 'skim milk'; keeps the amount."),
    search_query: text(200).optional().describe("USDA wording for replace_with, e.g. 'milk, nonfat, fluid'."),
  })
  .refine((c) => c.item_id !== undefined || c.food_name !== undefined, { message: "Give item_id or food_name" })
  .refine((c) => c.remove === true || c.quantity !== undefined || c.grams !== undefined || c.replace_with !== undefined, {
    message: "Give quantity, grams, replace_with, or remove: true",
  });

type ItemChange = z.output<typeof itemChangeSchema>;

// "eggs" should find "Egg, scrambled": compare lowercase words, singular.
function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("oes")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

const nameWords = (name: string) => name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(singular);

function matchesItem(item: Pick<MealItem, "id" | "food_name">, change: ItemChange): boolean {
  if (change.item_id) return item.id === change.item_id;
  const needle = change.food_name!.toLowerCase().trim();
  if (item.food_name.toLowerCase().includes(needle)) return true;
  const have = new Set(nameWords(item.food_name));
  const want = nameWords(needle);
  return want.length > 0 && want.every((word) => have.has(word));
}

function findItem(items: MealItem[], change: ItemChange): number {
  const matches = items.flatMap((item, i) => (matchesItem(item, change) ? [i] : []));
  if (change.item_id && matches.length === 0) throw new ToolInputError("That item isn't in this meal.");
  if (matches.length === 0) throw new ToolInputError(`No item matching "${change.food_name}" in this meal.`);
  if (matches.length > 1) throw new ToolInputError(`More than one item matches "${change.food_name}"; ask which one.`);
  return matches[0]!;
}

function resize(item: MealItem, change: { quantity?: number; grams?: number }): MealItem {
  try {
    return resizeItem(item, change);
  } catch (error) {
    if (error instanceof RangeError) throw new ToolInputError(`Can't resize ${item.food_name}.`);
    throw error;
  }
}

// A food swap ("actually that was skim milk"): the new food's USDA nutrition at the item's old amount.
// Matched with B5's matcher, which rejects a weak match rather than substituting another food.
async function replaceFood(item: MealItem, change: ItemChange, lookup: NutritionLookup): Promise<MealItem> {
  const name = change.replace_with!;
  const byWeight = item.grams !== null;
  const result = await matchFood(
    {
      name,
      quantity: byWeight ? item.grams! : item.quantity,
      unit: byWeight ? "g" : item.unit,
      preparation: null,
      inferred: item.inferred,
      confidence: "medium",
      search_query: change.search_query ?? name,
      brand: null,
      notes: null,
    },
    lookup,
  );
  const basis = result.status === "matched" ? result.item.basis_per_100g : null;
  const grams = item.grams ?? (result.status === "matched" ? result.item.grams : null);
  if (result.status !== "matched" || !basis || grams === null) {
    throw new ToolInputError(`Couldn't find nutrition data for "${name}", so nothing was changed. Ask the user for more detail.`);
  }
  return {
    ...item,
    food_name: name.charAt(0).toUpperCase() + name.slice(1),
    grams,
    basis_per_100g: basis,
    macros: itemMacros(basis, grams),
    nutrition_source: "usda",
    source_reference: result.item.source_reference,
    confidence: result.item.confidence,
    assumptions: result.item.assumptions,
  };
}

const updateMealSchema = z
  .strictObject({
    meal_id: uuid
      .optional()
      .describe("From recent meals or a card. Omit if unclear which meal: the tool finds the one with the item, or returns candidates."),
    version: z.number().int().positive().optional().describe("The version shown with meal_id (required with it)."),
    name: text(120).optional(),
    time_phrase: text(100).optional().describe("The user's words for a time move, e.g. 'lunch yesterday'."),
    consumed_at: isoDateTime.optional().describe("Exact ISO time with offset; only without time words."),
    scale: z.number().finite().positive().max(10).optional().describe("Multiply all amounts, e.g. 0.5 for 'I only ate half'."),
    item_changes: z.array(itemChangeSchema).max(20).optional(),
  })
  .refine((a) => a.meal_id === undefined || a.version !== undefined, {
    message: "Give the version you saw with meal_id",
    path: ["version"],
  })
  .refine(
    (a) =>
      a.name !== undefined ||
      a.time_phrase !== undefined ||
      a.consumed_at !== undefined ||
      a.scale !== undefined ||
      (a.item_changes?.length ?? 0) > 0,
    { message: "Nothing to change" },
  );

type UpdateMealArgs = z.output<typeof updateMealSchema>;

type UpdateTarget = { meal: Meal } | { candidates: Array<{ meal: Meal; matching_items: string[] }> };

// PRD 12.5: with no meal_id, the target is the one recent meal that has every item the change names.
// Several → candidates for the model to ask about; never a guess.
async function findUpdateTarget(args: UpdateMealArgs, store: MealStore): Promise<UpdateTarget> {
  if (args.meal_id) {
    const meal = await store.getMeal(args.meal_id);
    if (!meal || meal.status !== "active") throw new ToolInputError("No saved meal with that ID.");
    return { meal };
  }
  const changes = args.item_changes ?? [];
  const recent = (await store.recentMeals(RECENT_MEALS)).filter((meal) => meal.status === "active");
  const fits = recent.flatMap((meal) => {
    const hits = changes.map((change) => meal.items.filter((item) => matchesItem(item, change)));
    if (!hits.every((list) => list.length > 0)) return [];
    return [{ meal, matching_items: [...new Set(hits.flat().map((item) => item.food_name))] }];
  });
  if (fits.length === 1) return { meal: fits[0]!.meal };
  if (fits.length === 0) {
    throw new ToolInputError(
      changes.length > 0 ? "None of the recent meals has that item. Ask the user which meal they mean." : "No recent meals to change.",
    );
  }
  return { candidates: fits };
}

// PRD 12.14: the model's edit is based on the version it saw. If the user changed the meal since, nothing
// is written; the model gets what's saved now and tells the user instead of overwriting their edit.
function versionConflict(current: Meal | null, seen: number): ToolInputError {
  if (!current || current.status !== "active") return new ToolInputError("That meal was deleted, so nothing was changed.");
  return new ToolInputError(
    `Nothing was changed: the meal was edited after version ${seen} and is now version ${current.version}. current_meal is what's saved now. Tell the user, and ask before changing it again.`,
    { current_meal: mealSummary(current) },
  );
}

const FUTURE_GRACE_MS = 2 * 60 * 60_000; // same grace as the date resolver's early logging

function newConsumedAt(args: UpdateMealArgs, meal: Meal, ctx: ToolContext): string | undefined {
  if (args.time_phrase) {
    // The user's words, resolved in code (FR-09). A day without a time keeps the meal's time of day.
    const parsed = parseTimePhrase(args.time_phrase, ctx.now, ctx.timezone, { clockFrom: new Date(meal.consumed_at) });
    if (parsed) return inUserZone(parsed, ctx.timezone);
    if (!args.consumed_at) throw new ToolInputError(`Couldn't tell when "${args.time_phrase}" is. Ask the user for the day and time.`);
  }
  if (args.consumed_at) {
    if (Date.parse(args.consumed_at) > ctx.now.getTime() + FUTURE_GRACE_MS) throw new ToolInputError("A meal can't be moved into the future.");
    return args.consumed_at;
  }
  return undefined;
}

async function changedItems(meal: Meal, args: UpdateMealArgs, ctx: ToolContext): Promise<MealItem[]> {
  let items: MealItem[] = meal.items.map((item) => ({ ...item }));
  if (args.scale !== undefined) {
    const factor = args.scale;
    items = items.map((item) => ({ ...resize(item, { quantity: item.quantity * factor }), edited_by_user: true }));
  }
  const removed = new Set<number>();
  for (const change of args.item_changes ?? []) {
    const index = findItem(items, change);
    if (change.remove) {
      removed.add(index);
      continue;
    }
    let next = items[index]!;
    if (change.replace_with) next = await replaceFood(next, change, ctx.lookup);
    if (change.quantity !== undefined || change.grams !== undefined) next = resize(next, change);
    items[index] = { ...next, edited_by_user: true };
  }
  items = items.filter((_, i) => !removed.has(i));
  if (items.length === 0) throw new ToolInputError("That would remove every item; delete the meal instead.");
  return items;
}

const updateMeal = tool({
  name: "update_meal",
  description:
    "Correct a saved meal: rename, move its time, scale, or change, swap, or remove items; the server recalculates nutrition. If the meal changed since the version you pass, nothing is written and the current meal is returned. Never guess the meal: omit meal_id to let the tool check, and ask when it returns needs_clarification.",
  schema: updateMealSchema,
  needs: "meals",
  async run(args, ctx, state) {
    const store = requireMeals(ctx);
    const target = await findUpdateTarget(args, store);
    if ("candidates" in target) {
      return {
        status: "needs_clarification",
        note: "Nothing was changed: more than one recent meal fits. Ask the user which one (by name and time), then call update_meal with its meal_id and version.",
        candidates: target.candidates.map(({ meal, matching_items }) => ({
          meal_id: meal.id,
          version: meal.version,
          name: meal.name,
          consumed_at: inUserZone(new Date(meal.consumed_at), ctx.timezone),
          matching_items,
        })),
      };
    }

    const { meal } = target;
    if (args.version !== undefined && args.version !== meal.version) throw versionConflict(meal, args.version);

    const patch: UpdateMealRequest = { version: meal.version };
    if (args.name !== undefined) patch.name = args.name;
    const consumedAt = newConsumedAt(args, meal, ctx);
    if (consumedAt !== undefined) patch.consumed_at = consumedAt;
    if (args.scale !== undefined || (args.item_changes?.length ?? 0) > 0) patch.items = await changedItems(meal, args, ctx);

    let updated: Meal;
    try {
      updated = await store.updateMeal(meal.id, patch);
    } catch (error) {
      // Edited between our read and the write: the SQL function's row-locked version check caught it.
      if (error instanceof ApiErrorException && error.code === "version_conflict") {
        throw versionConflict(await store.getMeal(meal.id), meal.version);
      }
      throw error;
    }
    putMealCard(state, updated);
    return { status: "updated", ...mealSummary(updated) };
  },
});

const deleteMeal = tool({
  name: "delete_meal",
  description: "Delete a saved meal by meal_id, when the user asks. The user can undo for a few seconds.",
  schema: z.strictObject({ meal_id: uuid }),
  needs: "meals",
  async run(args, ctx, state) {
    const store = requireMeals(ctx);
    const meal = await store.getMeal(args.meal_id);
    if (!meal || meal.status !== "active") throw new ToolInputError("No saved meal with that ID.");
    const { undo_until } = await store.deleteMeal(meal.id);
    state.meals.delete(meal.id);
    state.mealChanged = true;
    const card: MealCard = { kind: "meal", meal_id: meal.id, meal: null };
    const index = state.cards.findIndex((c) => c.kind === "meal" && c.meal_id === meal.id);
    if (index === -1) state.cards.push(card);
    else state.cards[index] = card;
    return { status: "deleted", meal_id: meal.id, name: meal.name, undo_until };
  },
});

const getDailyTotals = tool({
  name: "get_daily_totals",
  description: "Get saved totals, targets, remaining macros, and meals for one day (default today, user's time zone).",
  schema: z.strictObject({ date: isoDate.optional().describe("YYYY-MM-DD") }),
  needs: "meals",
  async run(args, ctx) {
    const day = await requireMeals(ctx).dailySummary(args.date);
    return {
      date: day.date,
      consumed: roundMacros(day.consumed),
      targets: day.targets && roundMacros(day.targets),
      remaining: day.remaining && roundMacros(day.remaining),
      meals: day.meals.map((m) => ({ meal_id: m.id, name: m.name, consumed_at: m.consumed_at, totals: roundMacros(m.totals) })),
    };
  },
});

// Per-day lists the model gets in full only for short ranges; long ranges get the counts.
const MAX_LISTED_DAYS = 31;

function historyAggregate(agg: NonNullable<MealHistoryResult["aggregate"]>) {
  return {
    from: agg.from,
    to: agg.to,
    days_in_range: agg.days_in_range,
    days_with_records: agg.days_with_records,
    missing_dates: agg.missing_dates.slice(0, MAX_LISTED_DAYS),
    ...(agg.missing_dates.length > MAX_LISTED_DAYS ? { missing_dates_truncated: true } : {}),
    includes_today: agg.includes_today,
    sum: roundMacros(agg.sum),
    // null, never 0, when no day in the range has records (PRD §13).
    average_per_recorded_day: agg.average_per_recorded_day && roundMacros(agg.average_per_recorded_day),
    ...(agg.days.length <= MAX_LISTED_DAYS
      ? { days: agg.days.map((d) => ({ date: d.date, meals: d.meal_count, totals: roundMacros(d.totals) })) }
      : {}),
    ...(agg.days_with_records === 0 ? { note: "No records in this range. Say so; don't report a total of 0." } : {}),
  };
}

const searchMealHistory = tool({
  name: "search_meal_history",
  description:
    "Saved meals by local date range (YYYY-MM-DD, inclusive) and/or food name, newest first. Days without records are unknown, not zero.",
  schema: z
    .strictObject({
      from: isoDate.optional(),
      to: isoDate.optional(),
      query: text(100).optional().describe("Food or meal name."),
      limit: z.number().int().min(1).max(30).default(10),
      aggregate: z.boolean().optional().describe("Sum and average per recorded day over from..to, all meals in range. Needs from."),
      latest_match: z.boolean().optional().describe("'When did I last have X': the newest meal matching query, up to to."),
    })
    .refine((a) => !a.from || !a.to || a.from <= a.to, { message: "from must not be after to", path: ["from"] })
    .refine((a) => !a.aggregate || a.from, { message: "aggregate needs from", path: ["from"] })
    .refine((a) => !a.latest_match || a.query, { message: "latest_match needs query", path: ["query"] })
    .refine((a) => !(a.latest_match && a.aggregate), { message: "Use aggregate or latest_match, not both" }),
  needs: "meals",
  async run(args, ctx) {
    // userId is bound into the store from the session; the zone and clock are the session's too.
    const store = requireMeals(ctx);
    const session: SessionClock = { timezone: ctx.timezone, now: ctx.now };

    if (args.latest_match) {
      const hit = await store.lastMatching({ q: args.query!, before: args.to }, session);
      if (!hit) return { latest_match: null, note: `No saved meal matches "${args.query}".` };
      return {
        latest_match: {
          local_date: hit.local_date,
          days_ago: hit.days_ago,
          matched_items: hit.matched_items,
          meal: mealSummary(hit.meal),
        },
      };
    }

    const result = await store.searchHistory(
      { from: args.from, to: args.to, q: args.query, limit: args.limit, aggregate: args.aggregate },
      session,
    );
    return {
      today: result.today,
      meals: result.meals.map((m) => ({
        meal_id: m.id,
        name: m.name,
        local_date: m.local_date,
        consumed_at: inUserZone(new Date(m.consumed_at), ctx.timezone),
        totals: roundMacros(m.totals),
      })),
      has_more: result.has_more,
      ...(result.aggregate ? { aggregate: historyAggregate(result.aggregate) } : {}),
    };
  },
});

const getNutritionGoals = tool({
  name: "get_nutrition_goals",
  description: "Read the user's daily targets in effect on a date (default today). Read-only: goals can only be changed in Settings.",
  schema: z.strictObject({ date: isoDate.optional() }),
  async run(args, ctx) {
    const goals = await getGoalsOn(ctx.supabase, ctx.userId, args.date ?? localDate(ctx.now, ctx.timezone));
    return goals ? { goals } : { goals: null, note: "No goals set." };
  },
});

const searchUserMemories = tool({
  name: "search_user_memories",
  description: "Search what the user asked you to remember (usual foods, portions, brands, dietary notes).",
  schema: z.strictObject({ query: text(200) }),
  needs: "memory",
  async run(args, ctx) {
    const memories = await requireMemory(ctx).search(args.query);
    return { memories: memories.map((m) => ({ memory_id: m.id, category: m.category, content: m.content })) };
  },
});

const saveUserMemory = tool({
  name: "save_user_memory",
  description:
    "Remember a reusable preference when the user asks you to in this message, e.g. 'remember my usual shake is Fairlife Core Power 26g'. Quote the user's own words in evidence; nothing is saved without them.",
  schema: z.strictObject({
    category: memorySchema.shape.category,
    content: text(300).describe("The fact, short and self-contained, e.g. 'Usual shake: Fairlife Core Power 26g, 1 bottle'."),
    evidence: text(300).describe("The user's own words from this message that state it."),
  }),
  needs: "memory",
  async run(args, ctx) {
    const result = await requireMemory(ctx).save(args);
    if (result.status === "not_stated") {
      throw new ToolInputError("Not saved: only something the user states in this message can be remembered.");
    }
    return { status: result.status === "duplicate" ? "already_saved" : result.status, memory_id: result.memory.id };
  },
});

const deleteUserMemory = tool({
  name: "delete_user_memory",
  description: "Forget a saved memory by memory_id, when the user asks.",
  schema: z.strictObject({ memory_id: uuid }),
  needs: "memory",
  async run(args, ctx) {
    if (!(await requireMemory(ctx).remove(args.memory_id))) throw new ToolInputError("No memory with that ID.");
    return { status: "deleted" };
  },
});

export const TOOLS = [
  searchNutritionFoods,
  getFoodNutrition,
  createMealProposal,
  saveMeal,
  updateMeal,
  deleteMeal,
  getDailyTotals,
  searchMealHistory,
  getNutritionGoals,
  searchUserMemories,
  saveUserMemory,
  deleteUserMemory,
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];

const BY_NAME = new Map<string, ToolSpec<z.ZodType>>(TOOLS.map((t) => [t.name, t as unknown as ToolSpec<z.ZodType>]));

// Zod spells formats out as long regexes (a uuid is ~200 characters, a date-time ~400) and gives every
// int a MAX_SAFE_INTEGER bound. The model only needs `format`; Zod still checks the full rule on input.
// Dropping them keeps the cached prefix inside the context budget (context.ts).
function compactSchema(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(compactSchema);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (typeof obj.format === "string") delete obj.pattern;
  if (obj.maximum === Number.MAX_SAFE_INTEGER) delete obj.maximum;
  if (obj.minimum === Number.MIN_SAFE_INTEGER) delete obj.minimum;
  Object.values(obj).forEach(compactSchema);
}

function toolJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  delete json.$schema;
  compactSchema(json);
  return json;
}

function isOffered(spec: Pick<ToolSpec<z.ZodType>, "needs">, ctx: Pick<ToolContext, "meals" | "memory">): boolean {
  if (spec.needs === "meals") return ctx.meals !== null;
  if (spec.needs === "memory") return ctx.memory !== null;
  return true;
}

// Tool definitions for the provider, in a fixed order so the cached prefix stays identical. Tools whose
// store isn't wired yet are left out rather than offered and failing.
export function toolDefs(ctx: Pick<ToolContext, "meals" | "memory">): ToolDef[] {
  return TOOLS.filter((spec) => isOffered(spec, ctx)).map((spec) => ({
    name: spec.name,
    description: spec.description,
    parameters: toolJsonSchema(spec.schema),
  }));
}

function zodMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
}

// Runs one model tool call. Never throws for the model's mistakes or a tool failing: those come back
// as an error result the model can explain. Only the session user's context is used.
export async function runTool(call: ToolCall, ctx: ToolContext, state: TurnState): Promise<ToolResult> {
  const fail = (message: string, details?: Record<string, unknown>): ToolResult => {
    state.tools.push({ name: call.name, ok: false });
    return { callId: call.id, name: call.name, output: { error: message, ...details }, isError: true };
  };

  const spec = BY_NAME.get(call.name);
  if (!spec || !isOffered(spec, ctx)) return fail(`Unknown tool: ${call.name}`);

  const parsed = spec.schema.safeParse(call.input ?? {});
  if (!parsed.success) return fail(`Invalid arguments: ${zodMessage(parsed.error)}`);

  try {
    const output = await spec.run(parsed.data, ctx, state);
    state.tools.push({ name: call.name, ok: true });
    return { callId: call.id, name: call.name, output };
  } catch (error) {
    if (error instanceof ToolInputError) return fail(error.message, error.details);
    // A data-layer option check the tool schema didn't catch (e.g. a history range over 366 days).
    if (error instanceof z.ZodError) return fail(`Invalid arguments: ${zodMessage(error)}`);
    if (error instanceof ApiErrorException) {
      // e.g. version_conflict, not_found, ai_unavailable: the safe user-facing message, plus any
      // field messages ("That amount is too large.").
      const fields = Object.values(error.options.fields ?? {});
      return fail(fields.length > 0 ? `${error.message} ${fields.join(" ")}` : error.message);
    }
    // Error name only: messages can carry database values (food names) or provider output.
    console.error(`chat tool ${call.name} failed:`, error instanceof Error ? error.name : typeof error);
    return fail("Something went wrong running that tool, so it didn't go through.");
  }
}
