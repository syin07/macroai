import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type {
  DailySummary,
  Macros,
  Meal,
  MealCard,
  MealItem,
  MealListItem,
  MealProposal,
  MealSourceType,
  Memory,
  Preferences,
  UpdateMealRequest,
} from "@/types/api";
import { ApiErrorException } from "@/lib/api-error";
import { getGoalsOn } from "@/lib/database/goals";
import { localDate } from "@/lib/database/profile";
import { resizeItem } from "@/lib/nutrition/calc";
import type { NutritionLookup } from "@/lib/nutrition/usda";
import { isoDate, isoDateTime, text, uuid } from "@/lib/validation/common";
import { memorySchema } from "@/lib/validation/account";
import type { SaveStatedMemoryResult } from "@/lib/memory/extract";
import type { MealAnalysis } from "./analyze";
import type { MealImage, ToolCall, ToolDef, ToolResult } from "./provider";

// The chat model's tools (PRD §5.7). Each one is a plain server function: the model supplies
// arguments, Zod validates them, and the code acts for the session user carried in ToolContext. No
// argument names a user, so the model can't reach anyone else's data, and every write goes through
// the meal store (B7's validated functions), never straight to a table.
//
// Nothing the model sends is trusted for nutrition: save_meal takes only a proposal ID and saves the
// server's own copy of that proposal; update_meal takes amounts and recalculates with calc.ts.

// --- Dependencies ---------------------------------------------------------------------------------

// B7's meal functions, bound to the session user. See createMealStore() in ./meal-store.
export interface MealStore {
  saveProposal(proposal: MealProposal, sourceType: MealSourceType): Promise<Meal>; // idempotent on proposal_id
  getMeal(mealId: string): Promise<Meal | null>;
  getMeals(mealIds: string[]): Promise<Map<string, Meal>>;
  updateMeal(mealId: string, patch: UpdateMealRequest): Promise<Meal>;
  deleteMeal(mealId: string): Promise<{ undo_until: string }>;
  dailySummary(date?: string): Promise<DailySummary>; // today in the user's zone when omitted
  searchMeals(query: { from?: string; to?: string; q?: string; limit: number }): Promise<MealListItem[]>;
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

// A failure the model should see and explain (bad target, nothing to change). Not logged.
export class ToolInputError extends Error {
  constructor(message: string) {
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
    food_name: text(200).optional().describe("Used to find the item when item_id isn't known, e.g. 'rice'."),
    quantity: z.number().finite().positive().max(10_000).optional(),
    grams: z.number().finite().positive().max(10_000).optional(),
    remove: z.boolean().optional(),
  })
  .refine((c) => c.item_id !== undefined || c.food_name !== undefined, { message: "Give item_id or food_name" })
  .refine((c) => c.remove === true || c.quantity !== undefined || c.grams !== undefined, {
    message: "Give quantity, grams, or remove: true",
  });

function findItem(items: MealItem[], change: z.output<typeof itemChangeSchema>): number {
  if (change.item_id) {
    const index = items.findIndex((item) => item.id === change.item_id);
    if (index === -1) throw new ToolInputError("That item isn't in this meal.");
    return index;
  }
  const needle = change.food_name!.toLowerCase();
  const matches = items.flatMap((item, i) => (item.food_name.toLowerCase().includes(needle) ? [i] : []));
  if (matches.length === 0) throw new ToolInputError(`No item matching "${change.food_name}" in this meal.`);
  if (matches.length > 1) throw new ToolInputError(`More than one item matches "${change.food_name}"; ask which one.`);
  return matches[0]!;
}

const updateMeal = tool({
  name: "update_meal",
  description:
    "Correct a saved meal: rename it, move its time, change an item's amount, or remove an item. Nutrition is recalculated by the server. Identify the meal by meal_id from cards or today's meals; if several could match, ask first.",
  schema: z
    .strictObject({
      meal_id: uuid,
      version: z.number().int().positive().optional().describe("The meal version you last saw, if known."),
      name: text(120).optional(),
      consumed_at: isoDateTime.optional().describe("ISO 8601 with UTC offset."),
      item_changes: z.array(itemChangeSchema).max(20).optional(),
    })
    .refine((a) => a.name !== undefined || a.consumed_at !== undefined || (a.item_changes?.length ?? 0) > 0, {
      message: "Nothing to change",
    }),
  needs: "meals",
  async run(args, ctx, state) {
    const store = requireMeals(ctx);
    const meal = await store.getMeal(args.meal_id);
    if (!meal || meal.status !== "active") throw new ToolInputError("No saved meal with that ID.");

    const patch: UpdateMealRequest = { version: args.version ?? meal.version };
    if (args.name !== undefined) patch.name = args.name;
    if (args.consumed_at !== undefined) patch.consumed_at = args.consumed_at;

    if (args.item_changes?.length) {
      let items: MealItem[] = meal.items.map((item) => ({ ...item }));
      const removed = new Set<number>();
      for (const change of args.item_changes) {
        const index = findItem(items, change);
        if (change.remove) {
          removed.add(index);
          continue;
        }
        try {
          items[index] = { ...resizeItem(items[index]!, change), edited_by_user: true };
        } catch (error) {
          if (error instanceof RangeError) throw new ToolInputError(`Can't resize ${items[index]!.food_name}.`);
          throw error;
        }
      }
      items = items.filter((_, i) => !removed.has(i));
      if (items.length === 0) throw new ToolInputError("That would remove every item; delete the meal instead.");
      patch.items = items;
    }

    const updated = await store.updateMeal(meal.id, patch);
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

const searchMealHistory = tool({
  name: "search_meal_history",
  description:
    "Search saved meals by date range (YYYY-MM-DD, user's time zone) and/or food name, newest first. Days without records are unknown, not zero.",
  schema: z
    .strictObject({
      from: isoDate.optional(),
      to: isoDate.optional(),
      query: text(100).optional(),
      limit: z.number().int().min(1).max(30).default(10),
    })
    .refine((a) => !a.from || !a.to || a.from <= a.to, { message: "from must not be after to", path: ["from"] }),
  needs: "meals",
  async run(args, ctx) {
    const meals = await requireMeals(ctx).searchMeals({ from: args.from, to: args.to, q: args.query, limit: args.limit });
    return {
      meals: meals.map((m) => ({ meal_id: m.id, name: m.name, consumed_at: m.consumed_at, totals: roundMacros(m.totals) })),
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

function toolJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  delete json.$schema;
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
  const fail = (message: string): ToolResult => {
    state.tools.push({ name: call.name, ok: false });
    return { callId: call.id, name: call.name, output: { error: message }, isError: true };
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
    if (error instanceof ToolInputError) return fail(error.message);
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
