import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { Meal, MealItem, MealProposal } from "@/types/api";
import { ApiErrorException } from "@/lib/api-error";
import { itemMacros } from "@/lib/nutrition/calc";
import type { MealAnalysis } from "./analyze";
import { MAX_PROPOSAL_CALLS, newTurnState, runTool, toolDefs, type MealStore, type ToolContext } from "./tools";

const NOW = new Date("2026-10-26T19:00:00Z");
const RICE = { calories: 130, protein_g: 2.38, carbs_g: 28.59, fat_g: 0.21 };

function item(overrides: Partial<MealItem> = {}): MealItem {
  return {
    id: randomUUID(),
    food_name: "Cooked white rice",
    quantity: 1,
    unit: "cup",
    grams: 160,
    basis_per_100g: RICE,
    macros: itemMacros(RICE, 160),
    nutrition_source: "usda",
    source_reference: "168930",
    inferred: false,
    confidence: "medium",
    edited_by_user: false,
    assumptions: null,
    ...overrides,
  };
}

function proposal(name = "Chicken and Rice", extra: Partial<MealProposal> = {}): MealProposal {
  const items = [item()];
  return {
    proposal_id: randomUUID(),
    name,
    consumed_at: "2026-10-26T12:00:00-07:00",
    items,
    totals: items[0]!.macros,
    needs_clarification: false,
    clarification_question: null,
    ...extra,
  };
}

function savedMeal(p: MealProposal, extra: Partial<Meal> = {}): Meal {
  return {
    id: randomUUID(),
    name: p.name,
    consumed_at: p.consumed_at,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    source_type: "text",
    items: p.items.map((i) => ({ ...i, id: i.id ?? randomUUID() })),
    totals: p.totals,
    status: "active",
    version: 1,
    ...extra,
  };
}

function fakeMealStore(initial: Meal[] = []) {
  const meals = new Map(initial.map((m) => [m.id, m]));
  const store = {
    saveProposal: vi.fn(async (p: MealProposal) => {
      const meal = savedMeal(p);
      meals.set(meal.id, meal);
      return meal;
    }),
    getMeal: vi.fn(async (id: string) => meals.get(id) ?? null),
    getMeals: vi.fn(async () => new Map(meals)),
    updateMeal: vi.fn(async (id: string, patch: Parameters<MealStore["updateMeal"]>[1]) => {
      const current = meals.get(id)!;
      if (patch.version !== current.version) throw new ApiErrorException("version_conflict");
      const next = { ...current, ...patch, items: (patch.items as MealItem[]) ?? current.items, version: current.version + 1 };
      meals.set(id, next);
      return next;
    }),
    deleteMeal: vi.fn(async (id: string) => {
      meals.delete(id);
      return { undo_until: new Date(NOW.getTime() + 10_000).toISOString() };
    }),
    dailySummary: vi.fn(),
    searchMeals: vi.fn(async () => []),
  };
  return store satisfies MealStore;
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: "11111111-1111-4111-8111-111111111111",
    supabase: {} as SupabaseClient,
    now: NOW,
    timezone: "America/Los_Angeles",
    saveMode: "confirm",
    analyze: vi.fn(async (): Promise<MealAnalysis> => ({ intent: "log_meal", proposals: [proposal()], explanation: null, model: "m", promptVersion: "v" })),
    lookup: { searchFoods: vi.fn(async () => []), getFood: vi.fn(async () => null) },
    meals: fakeMealStore(),
    memory: null,
    priorProposals: new Map(),
    ...overrides,
  };
}

const call = (name: string, input: unknown) => ({ id: randomUUID(), name, input });

describe("toolDefs", () => {
  it("offers the PRD §5.7 tools in a fixed order, leaving out tools whose store isn't wired", () => {
    expect(toolDefs({ meals: null, memory: null }).map((t) => t.name)).toEqual([
      "search_nutrition_foods",
      "get_food_nutrition",
      "create_meal_proposal",
      "get_nutrition_goals",
    ]);
    const all = toolDefs({ meals: fakeMealStore(), memory: { search: vi.fn(), save: vi.fn(), remove: vi.fn() } });
    expect(all.map((t) => t.name)).toEqual([
      "search_nutrition_foods",
      "get_food_nutrition",
      "create_meal_proposal",
      "save_meal",
      "update_meal",
      "delete_meal",
      "get_daily_totals",
      "search_meal_history",
      "get_nutrition_goals",
      "search_user_memories",
      "save_user_memory",
      "delete_user_memory",
    ]);
  });

  it("has no tool that can change goals, and no tool input that names a user", () => {
    const defs = toolDefs({ meals: fakeMealStore(), memory: { search: vi.fn(), save: vi.fn(), remove: vi.fn() } });
    expect(defs.filter((t) => /goal/.test(t.name)).map((t) => t.name)).toEqual(["get_nutrition_goals"]);
    for (const def of defs) {
      expect(def.parameters).toMatchObject({ type: "object", additionalProperties: false });
      expect(Object.keys((def.parameters.properties as object) ?? {})).not.toContain("user_id");
      expect(def.parameters).not.toHaveProperty("$schema");
    }
  });
});

describe("runTool — argument validation", () => {
  it.each([
    ["an unknown tool", "drop_tables", {}],
    ["a tool that isn't offered", "save_user_memory", { category: "brand", content: "x" }],
    ["a non-UUID proposal_id", "save_meal", { proposal_id: "1; drop table meals" }],
    ["an extra user_id argument", "save_meal", { proposal_id: randomUUID(), user_id: randomUUID() }],
    ["an empty description", "create_meal_proposal", { description: "   " }],
    ["an update with nothing to change", "update_meal", { meal_id: randomUUID() }],
    ["a negative amount", "update_meal", { meal_id: randomUUID(), item_changes: [{ food_name: "rice", grams: -5 }] }],
    ["a time without a UTC offset", "update_meal", { meal_id: randomUUID(), consumed_at: "2026-10-26T12:00:00" }],
    ["a reversed date range", "search_meal_history", { from: "2026-10-20", to: "2026-10-01" }],
    ["missing input", "delete_meal", undefined],
  ])("rejects %s without touching the store", async (_label, name, input) => {
    const ctx = context();
    const state = newTurnState();
    const result = await runTool(call(name, input), ctx, state);
    expect(result.isError).toBe(true);
    expect(result.output).toEqual({ error: expect.any(String) });
    expect(state.tools).toEqual([{ name, ok: false }]);
    for (const fn of Object.values(ctx.meals!)) expect(fn).not.toHaveBeenCalled();
    expect(ctx.analyze).not.toHaveBeenCalled();
  });

  it("reports an unexpected failure without its message, so stored values never reach the model or logs", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = context({ meals: { ...fakeMealStore(), getMeal: vi.fn(async () => Promise.reject(new Error("row (secret burrito) failed"))) } });
    const result = await runTool(call("delete_meal", { meal_id: randomUUID() }), ctx, newTurnState());
    expect(JSON.stringify(result.output)).not.toContain("burrito");
    expect(JSON.stringify(errors.mock.calls)).not.toContain("burrito");
    errors.mockRestore();
  });
});

describe("create_meal_proposal", () => {
  it("confirm mode: returns unsaved proposal cards and saves nothing", async () => {
    const ctx = context();
    const state = newTurnState();
    const result = await runTool(call("create_meal_proposal", { description: "chicken and rice" }), ctx, state);
    expect(result.output).toMatchObject({ proposals: [{ status: "unsaved_awaiting_user" }] });
    expect(state.cards).toMatchObject([{ kind: "proposal", state: "unsaved" }]);
    expect(state.mealChanged).toBe(false);
    expect(ctx.meals!.saveProposal).not.toHaveBeenCalled();
  });

  it("auto mode: saves clear meals and keeps the unclear one as a question", async () => {
    const clear = proposal("Eggs");
    const unclear = proposal("Burger", { needs_clarification: true, clarification_question: "Which restaurant?" });
    const ctx = context({
      saveMode: "auto",
      analyze: vi.fn(async () => ({ intent: "log_meal" as const, proposals: [clear, unclear], explanation: null, model: "m", promptVersion: "v" })),
    });
    const state = newTurnState();
    const result = await runTool(call("create_meal_proposal", { description: "eggs and a burger" }), ctx, state);

    expect(result.output).toMatchObject({ proposals: [{ status: "saved" }, { status: "needs_clarification", clarification_question: "Which restaurant?" }] });
    expect(ctx.meals!.saveProposal).toHaveBeenCalledWith(clear, "text");
    expect(state.cards.map((c) => c.kind)).toEqual(["meal", "proposal"]);
    expect(state.mealChanged).toBe(true);
  });

  it("passes the current photo to extraction and saves photo meals as source_type photo", async () => {
    const image = { bytes: new Uint8Array([1, 2, 3]), mediaType: "image/jpeg" as const };
    const ctx = context({ saveMode: "auto", image });
    await runTool(call("create_meal_proposal", { description: "the meal in the photo" }), ctx, newTurnState());
    expect(ctx.analyze).toHaveBeenCalledWith({ text: "the meal in the photo", image });
    expect(ctx.meals!.saveProposal).toHaveBeenCalledWith(expect.anything(), "photo");
  });

  it(`stops after ${MAX_PROPOSAL_CALLS} extraction calls in one turn`, async () => {
    const ctx = context();
    const state = newTurnState();
    for (let i = 0; i < MAX_PROPOSAL_CALLS; i++) await runTool(call("create_meal_proposal", { description: "eggs" }), ctx, state);
    const third = await runTool(call("create_meal_proposal", { description: "eggs" }), ctx, state);
    expect(third.isError).toBe(true);
    expect(ctx.analyze).toHaveBeenCalledTimes(MAX_PROPOSAL_CALLS);
  });
});

describe("save_meal", () => {
  it("won't save a proposal the user hasn't seen yet in confirm mode", async () => {
    const ctx = context();
    const state = newTurnState();
    const created = await runTool(call("create_meal_proposal", { description: "chicken" }), ctx, state);
    const id = (created.output as { proposals: Array<{ proposal_id: string }> }).proposals[0]!.proposal_id;
    const result = await runTool(call("save_meal", { proposal_id: id }), ctx, state);
    expect(result.isError).toBe(true);
    expect(ctx.meals!.saveProposal).not.toHaveBeenCalled();
  });

  it("saves the server's copy of an earlier proposal and replaces nothing else", async () => {
    const earlier = proposal();
    const ctx = context({ priorProposals: new Map([[earlier.proposal_id, earlier]]) });
    const state = newTurnState();
    const result = await runTool(call("save_meal", { proposal_id: earlier.proposal_id }), ctx, state);
    expect(result.output).toMatchObject({ status: "saved" });
    expect(ctx.meals!.saveProposal).toHaveBeenCalledWith(earlier, "text");
    expect(state.cards).toMatchObject([{ kind: "meal" }]);
  });

  it("errors for an unknown proposal ID", async () => {
    const result = await runTool(call("save_meal", { proposal_id: randomUUID() }), context(), newTurnState());
    expect(result).toMatchObject({ isError: true, output: { error: "No unsaved proposal with that ID." } });
  });
});

describe("update_meal and delete_meal", () => {
  const base = () => savedMeal(proposal(), { items: [item({ food_name: "Grilled chicken", basis_per_100g: null, grams: 150, quantity: 150, unit: "g", macros: { calories: 250, protein_g: 46, carbs_g: 0, fat_g: 5 } }), item()] });

  it('"actually it was 200 g of rice": resizes by food name, recalculates, and marks the item edited', async () => {
    const meal = base();
    const store = fakeMealStore([meal]);
    const ctx = context({ meals: store });
    const state = newTurnState();
    const result = await runTool(call("update_meal", { meal_id: meal.id, item_changes: [{ food_name: "rice", grams: 200 }] }), ctx, state);

    expect(result.output).toMatchObject({ status: "updated", version: 2 });
    const patch = store.updateMeal.mock.calls[0]![1];
    expect(patch.version).toBe(1);
    const rice = patch.items!.find((i) => i.food_name === "Cooked white rice")!;
    expect(rice).toMatchObject({ grams: 200, edited_by_user: true });
    expect(rice.macros.calories).toBeCloseTo(260, 9);
    expect(patch.items!.find((i) => i.food_name === "Grilled chicken")!.edited_by_user).toBe(false);
    expect(state.cards).toMatchObject([{ kind: "meal", meal_id: meal.id }]);
    expect(state.mealChanged).toBe(true);
  });

  it("removes an item, but refuses to remove every item", async () => {
    const meal = base();
    const store = fakeMealStore([meal]);
    const ctx = context({ meals: store });
    await runTool(call("update_meal", { meal_id: meal.id, item_changes: [{ food_name: "rice", remove: true }] }), ctx, newTurnState());
    expect(store.updateMeal.mock.calls[0]![1].items!.map((i) => i.food_name)).toEqual(["Grilled chicken"]);

    const all = await runTool(
      call("update_meal", { meal_id: meal.id, item_changes: [{ food_name: "chicken", remove: true }] }),
      ctx,
      newTurnState(),
    );
    expect(all.isError).toBe(true);
  });

  it("asks instead of guessing when a food name matches more than one item", async () => {
    const meal = savedMeal(proposal(), { items: [item({ food_name: "Brown rice" }), item({ food_name: "White rice" })] });
    const ctx = context({ meals: fakeMealStore([meal]) });
    const result = await runTool(call("update_meal", { meal_id: meal.id, item_changes: [{ food_name: "rice", grams: 100 }] }), ctx, newTurnState());
    expect(result).toMatchObject({ isError: true, output: { error: expect.stringContaining("ask which one") } });
    expect(ctx.meals!.updateMeal).not.toHaveBeenCalled();
  });

  it("passes a stale version through, and reports the conflict to the model", async () => {
    const meal = base();
    const ctx = context({ meals: fakeMealStore([meal]) });
    const result = await runTool(call("update_meal", { meal_id: meal.id, version: 7, name: "Lunch" }), ctx, newTurnState());
    expect(result.isError).toBe(true);
    expect(result.output).toEqual({ error: expect.stringContaining("changed somewhere else") });
  });

  it("delete_meal adds a deleted (null) meal card and reports the undo window", async () => {
    const meal = base();
    const ctx = context({ meals: fakeMealStore([meal]) });
    const state = newTurnState();
    const result = await runTool(call("delete_meal", { meal_id: meal.id }), ctx, state);
    expect(result.output).toMatchObject({ status: "deleted", meal_id: meal.id, undo_until: expect.any(String) });
    expect(state.cards).toEqual([{ kind: "meal", meal_id: meal.id, meal: null }]);
    expect(state.mealChanged).toBe(true);
  });

  it("can't touch a meal the store doesn't return (another user's, or deleted)", async () => {
    const result = await runTool(call("delete_meal", { meal_id: randomUUID() }), context(), newTurnState());
    expect(result).toMatchObject({ isError: true, output: { error: "No saved meal with that ID." } });
  });
});
