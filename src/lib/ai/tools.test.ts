import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Meal, MealItem, MealProposal } from "@/types/api";
import { ApiErrorException } from "@/lib/api-error";
import type { LastMealMatch, MealHistoryResult } from "@/lib/database/history";
import { itemMacros } from "@/lib/nutrition/calc";
import { fakeLookup, SKIM_MILK } from "./__fixtures__/chat-fakes";
import type { MealAnalysis } from "./analyze";
import { MAX_PROPOSAL_CALLS, RECENT_MEALS, newTurnState, runTool, toolDefs, type MealStore, type ToolContext } from "./tools";

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
    recentMeals: vi.fn(async (limit: number) =>
      [...meals.values()].sort((a, b) => Date.parse(b.consumed_at) - Date.parse(a.consumed_at)).slice(0, limit),
    ),
    searchHistory: vi.fn(async (): Promise<MealHistoryResult> => {
      throw new Error("searchHistory not stubbed");
    }),
    lastMatching: vi.fn(async (): Promise<LastMealMatch | null> => null),
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
    ["a meal_id without the version the model saw", "update_meal", { meal_id: randomUUID(), name: "Lunch" }],
    ["a scale of zero", "update_meal", { meal_id: randomUUID(), version: 1, scale: 0 }],
    ["a reversed date range", "search_meal_history", { from: "2026-10-20", to: "2026-10-01" }],
    ["an aggregate without a start date", "search_meal_history", { aggregate: true }],
    ["a latest match without a food", "search_meal_history", { latest_match: true }],
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
    const result = await runTool(call("update_meal", { meal_id: meal.id, version: 1, item_changes: [{ food_name: "rice", grams: 200 }] }), ctx, state);

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
    await runTool(call("update_meal", { meal_id: meal.id, version: 1, item_changes: [{ food_name: "rice", remove: true }] }), ctx, newTurnState());
    expect(store.updateMeal.mock.calls[0]![1].items!.map((i) => i.food_name)).toEqual(["Grilled chicken"]);

    const all = await runTool(
      call("update_meal", { meal_id: meal.id, version: 2, item_changes: [{ food_name: "chicken", remove: true }] }),
      ctx,
      newTurnState(),
    );
    expect(all.isError).toBe(true);
  });

  it("asks instead of guessing when a food name matches more than one item", async () => {
    const meal = savedMeal(proposal(), { items: [item({ food_name: "Brown rice" }), item({ food_name: "White rice" })] });
    const ctx = context({ meals: fakeMealStore([meal]) });
    const result = await runTool(call("update_meal", { meal_id: meal.id, version: 1, item_changes: [{ food_name: "rice", grams: 100 }] }), ctx, newTurnState());
    expect(result).toMatchObject({ isError: true, output: { error: expect.stringContaining("ask which one") } });
    expect(ctx.meals!.updateMeal).not.toHaveBeenCalled();
  });

  it('finds "eggs" in "Egg, scrambled" (plural and word order)', async () => {
    const meal = savedMeal(proposal(), { items: [item({ food_name: "Egg, scrambled", quantity: 3, unit: "large", grams: 150 }), item()] });
    const store = fakeMealStore([meal]);
    const result = await runTool(
      call("update_meal", { meal_id: meal.id, version: 1, item_changes: [{ food_name: "eggs", quantity: 2 }] }),
      context({ meals: store }),
      newTurnState(),
    );
    expect(result.isError).toBeFalsy();
    expect(store.updateMeal.mock.calls[0]![1].items![0]).toMatchObject({ quantity: 2, grams: 100 });
  });

  it('scales every item for "I only ate half"', async () => {
    const meal = base();
    const store = fakeMealStore([meal]);
    await runTool(call("update_meal", { meal_id: meal.id, version: 1, scale: 0.5 }), context({ meals: store }), newTurnState());
    const items = store.updateMeal.mock.calls[0]![1].items!;
    expect(items.map((i) => i.grams)).toEqual([75, 80]);
    expect(items[0]!.macros.calories).toBeCloseTo(125, 9); // no basis: scaled
    expect(items[1]!.macros.calories).toBeCloseTo(104, 9); // basis × 80 g
    expect(items.every((i) => i.edited_by_user)).toBe(true);
  });

  it("swaps a food with replace_with: new USDA nutrition at the old amount", async () => {
    const meal = savedMeal(proposal(), { items: [item({ food_name: "Whole milk", quantity: 1, unit: "cup", grams: 244, basis_per_100g: null, macros: { calories: 149, protein_g: 7.7, carbs_g: 11.7, fat_g: 7.9 } })] });
    const store = fakeMealStore([meal]);
    const ctx = context({ meals: store, lookup: fakeLookup([SKIM_MILK]) });
    const result = await runTool(
      call("update_meal", { meal_id: meal.id, version: 1, item_changes: [{ food_name: "milk", replace_with: "skim milk", search_query: "milk, nonfat, fluid" }] }),
      ctx,
      newTurnState(),
    );
    expect(result.isError).toBeFalsy();
    const milk = store.updateMeal.mock.calls[0]![1].items![0]!;
    expect(milk).toMatchObject({ food_name: "Skim milk", quantity: 1, unit: "cup", grams: 244, nutrition_source: "usda", source_reference: String(SKIM_MILK.fdcId), basis_per_100g: SKIM_MILK.basis_per_100g, edited_by_user: true });
    expect(milk.macros.calories).toBeCloseTo(34 * 2.44, 9);
  });

  it("won't swap to a food the matcher can't find", async () => {
    const meal = base();
    const store = fakeMealStore([meal]);
    const result = await runTool(
      call("update_meal", { meal_id: meal.id, version: 1, item_changes: [{ food_name: "rice", replace_with: "cauliflower rice" }] }),
      context({ meals: store }),
      newTurnState(),
    );
    expect(result).toMatchObject({ isError: true, output: { error: expect.stringContaining("Couldn't find nutrition data") } });
    expect(store.updateMeal).not.toHaveBeenCalled();
  });

  it("moves the time with the user's words, keeping the time of day for a day-only phrase", async () => {
    const meal = base(); // 12:00 PDT on Oct 26; NOW is 12:00 PDT on Oct 26
    const store = fakeMealStore([meal]);
    const ctx = context({ meals: store });
    await runTool(call("update_meal", { meal_id: meal.id, version: 1, time_phrase: "yesterday" }), ctx, newTurnState());
    expect(store.updateMeal.mock.calls[0]![1].consumed_at).toBe("2026-10-25T12:00:00-07:00");
    await runTool(call("update_meal", { meal_id: meal.id, version: 2, time_phrase: "dinner last tuesday" }), ctx, newTurnState());
    expect(store.updateMeal.mock.calls[1]![1].consumed_at).toBe("2026-10-20T19:00:00-07:00");

    const unknown = await runTool(call("update_meal", { meal_id: meal.id, version: 3, time_phrase: "sometime" }), ctx, newTurnState());
    expect(unknown).toMatchObject({ isError: true, output: { error: expect.stringContaining("Ask the user") } });
    const future = await runTool(call("update_meal", { meal_id: meal.id, version: 3, consumed_at: "2026-10-27T12:00:00-07:00" }), ctx, newTurnState());
    expect(future.isError).toBe(true);
    expect(store.updateMeal).toHaveBeenCalledTimes(2);
  });

  describe("PRD 12.14: versions", () => {
    it("a stale version writes nothing and hands the model the meal as it is now", async () => {
      const meal = { ...base(), version: 3, name: "Renamed by the user" };
      const store = fakeMealStore([meal]);
      const result = await runTool(call("update_meal", { meal_id: meal.id, version: 2, name: "Lunch" }), context({ meals: store }), newTurnState());
      expect(result.isError).toBe(true);
      expect(result.output).toMatchObject({
        error: expect.stringContaining("now version 3"),
        current_meal: { meal_id: meal.id, version: 3, name: "Renamed by the user" },
      });
      expect(store.updateMeal).not.toHaveBeenCalled();
    });

    it("an edit that lands between the read and the write is re-read and reported, not retried", async () => {
      const meal = base();
      const store = fakeMealStore([meal]);
      store.updateMeal.mockImplementationOnce(async () => {
        store.getMeal.mockResolvedValueOnce({ ...meal, version: 2, name: "Edited in the app" });
        throw new ApiErrorException("version_conflict");
      });
      const state = newTurnState();
      const result = await runTool(call("update_meal", { meal_id: meal.id, version: 1, name: "Lunch" }), context({ meals: store }), state);
      expect(result.output).toMatchObject({ error: expect.stringContaining("now version 2"), current_meal: { version: 2, name: "Edited in the app" } });
      expect(store.updateMeal).toHaveBeenCalledTimes(1);
      expect(state.cards).toEqual([]);
    });

    it("a meal deleted in the meantime is reported as deleted", async () => {
      const meal = base();
      const store = fakeMealStore([meal]);
      store.updateMeal.mockImplementationOnce(async () => {
        store.getMeal.mockResolvedValueOnce(null);
        throw new ApiErrorException("version_conflict");
      });
      const result = await runTool(call("update_meal", { meal_id: meal.id, version: 1, name: "Lunch" }), context({ meals: store }), newTurnState());
      expect(result.output).toEqual({ error: "That meal was deleted, so nothing was changed." });
    });
  });

  describe("PRD 12.5: no meal_id", () => {
    const cheese = (name: string) => item({ food_name: name, basis_per_100g: null, grams: 28, quantity: 1, unit: "slice", macros: { calories: 113, protein_g: 7, carbs_g: 0.4, fat_g: 9.3 } });
    const burger = () => savedMeal(proposal("Cheeseburger", { consumed_at: "2026-10-26T12:15:00-07:00" }), { items: [item({ food_name: "Hamburger bun" }), cheese("American cheese")] });
    const omelette = () => savedMeal(proposal("Cheese omelette", { consumed_at: "2026-10-26T08:00:00-07:00" }), { items: [item({ food_name: "Egg" }), cheese("Cheddar cheese")], version: 2 });

    it("updates the one recent meal that has the item", async () => {
      const target = burger();
      const store = fakeMealStore([target, savedMeal(proposal("Oatmeal"), { consumed_at: "2026-10-26T07:00:00-07:00" })]);
      const result = await runTool(call("update_meal", { item_changes: [{ food_name: "cheese", remove: true }] }), context({ meals: store }), newTurnState());
      expect(result.output).toMatchObject({ status: "updated", meal_id: target.id });
      expect(store.recentMeals).toHaveBeenCalledWith(RECENT_MEALS);
      expect(store.updateMeal.mock.calls[0]![1]).toMatchObject({ version: 1 });
    });

    it("returns candidates instead of guessing when several recent meals have it, and writes nothing", async () => {
      const [a, b] = [burger(), omelette()];
      const store = fakeMealStore([a, b]);
      const state = newTurnState();
      const result = await runTool(call("update_meal", { item_changes: [{ food_name: "cheese", remove: true }] }), context({ meals: store }), state);
      expect(result.isError).toBeFalsy();
      expect(result.output).toMatchObject({
        status: "needs_clarification",
        candidates: [
          { meal_id: a.id, version: 1, name: "Cheeseburger", consumed_at: "2026-10-26T12:15:00-07:00", matching_items: ["American cheese"] },
          { meal_id: b.id, version: 2, name: "Cheese omelette", matching_items: ["Cheddar cheese"] },
        ],
      });
      expect(store.updateMeal).not.toHaveBeenCalled();
      expect(state.cards).toEqual([]);
      expect(state.mealChanged).toBe(false);
    });

    it("errors when no recent meal has the item", async () => {
      const store = fakeMealStore([burger()]);
      const result = await runTool(call("update_meal", { item_changes: [{ food_name: "salmon", remove: true }] }), context({ meals: store }), newTurnState());
      expect(result).toMatchObject({ isError: true, output: { error: expect.stringContaining("Ask the user which meal") } });
    });
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

describe("search_meal_history (B11)", () => {
  const historyResult = (overrides: Partial<MealHistoryResult> = {}): MealHistoryResult => ({
    timezone: "America/Los_Angeles",
    today: "2026-10-26",
    from: "2026-10-20",
    to: "2026-10-26",
    q: null,
    meals: [{ id: randomUUID(), name: "Dinner", consumed_at: "2026-10-26T02:00:00Z", local_date: "2026-10-25", totals: { calories: 700.4, protein_g: 40.6, carbs_g: 50, fat_g: 20 } }],
    has_more: false,
    aggregate: null,
    ...overrides,
  });

  it("passes the session's zone and clock, never a user from the model", async () => {
    const store = fakeMealStore();
    store.searchHistory.mockResolvedValueOnce(historyResult());
    const ctx = context({ meals: store });
    const result = await runTool(call("search_meal_history", { from: "2026-10-20", query: "dinner" }), ctx, newTurnState());
    expect(store.searchHistory).toHaveBeenCalledWith(
      { from: "2026-10-20", to: undefined, q: "dinner", limit: 10, aggregate: undefined },
      { timezone: "America/Los_Angeles", now: NOW },
    );
    expect(result.output).toEqual({
      today: "2026-10-26",
      meals: [{ meal_id: expect.any(String), name: "Dinner", local_date: "2026-10-25", consumed_at: "2026-10-25T19:00:00-07:00", totals: { calories: 700, protein_g: 41, carbs_g: 50, fat_g: 20 } }],
      has_more: false,
    });
  });

  it("aggregate: per recorded day, with the counts, missing dates, and today flagged as partial", async () => {
    const store = fakeMealStore();
    store.searchHistory.mockResolvedValueOnce(
      historyResult({
        aggregate: {
          from: "2026-10-20",
          to: "2026-10-26",
          days_in_range: 7,
          days_with_records: 2,
          missing_dates: ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"],
          sum: { calories: 3000, protein_g: 200, carbs_g: 300, fat_g: 100 },
          average_per_recorded_day: { calories: 1500, protein_g: 100, carbs_g: 150, fat_g: 50 },
          days: [
            { date: "2026-10-25", meal_count: 2, totals: { calories: 2000, protein_g: 120, carbs_g: 200, fat_g: 60 } },
            { date: "2026-10-26", meal_count: 1, totals: { calories: 1000, protein_g: 80, carbs_g: 100, fat_g: 40 } },
          ],
          includes_today: true,
          to_clamped_to_today: true,
        },
      }),
    );
    const result = await runTool(call("search_meal_history", { from: "2026-10-20", aggregate: true }), context({ meals: store }), newTurnState());
    expect(result.output).toMatchObject({
      aggregate: {
        days_in_range: 7,
        days_with_records: 2,
        missing_dates: ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"],
        includes_today: true,
        average_per_recorded_day: { calories: 1500, protein_g: 100 },
        days: [{ date: "2026-10-25", meals: 2 }, { date: "2026-10-26", meals: 1 }],
      },
    });
    expect(result.output).not.toHaveProperty("aggregate.note");
  });

  it("aggregate with no records: a null average and a note, never a zero", async () => {
    const store = fakeMealStore();
    store.searchHistory.mockResolvedValueOnce(
      historyResult({
        meals: [],
        aggregate: { from: "2026-10-01", to: "2026-10-02", days_in_range: 2, days_with_records: 0, missing_dates: ["2026-10-01", "2026-10-02"], sum: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }, average_per_recorded_day: null, days: [], includes_today: false, to_clamped_to_today: false },
      }),
    );
    const result = await runTool(call("search_meal_history", { from: "2026-10-01", to: "2026-10-02", aggregate: true }), context({ meals: store }), newTurnState());
    expect(result.output).toMatchObject({ aggregate: { average_per_recorded_day: null, note: expect.stringContaining("No records") } });
  });

  it("latest_match: 'when did I last have salmon' uses findLastMealMatching, bounded by to", async () => {
    const store = fakeMealStore();
    const meal = savedMeal(proposal("Salmon bowl"));
    store.lastMatching.mockResolvedValueOnce({ meal, local_date: "2026-10-21", days_ago: 5, matched_items: ["Salmon, baked"] });
    const result = await runTool(call("search_meal_history", { query: "salmon", latest_match: true, to: "2026-10-25" }), context({ meals: store }), newTurnState());
    expect(store.lastMatching).toHaveBeenCalledWith({ q: "salmon", before: "2026-10-25" }, { timezone: "America/Los_Angeles", now: NOW });
    expect(store.searchHistory).not.toHaveBeenCalled();
    expect(result.output).toMatchObject({ latest_match: { local_date: "2026-10-21", days_ago: 5, matched_items: ["Salmon, baked"], meal: { meal_id: meal.id, name: "Salmon bowl" } } });

    const none = await runTool(call("search_meal_history", { query: "salmon", latest_match: true }), context({ meals: store }), newTurnState());
    expect(none.output).toMatchObject({ latest_match: null });
  });

  it("reports a data-layer range error as invalid arguments", async () => {
    const store = fakeMealStore();
    store.searchHistory.mockRejectedValueOnce(new z.ZodError([{ code: "custom", path: ["to"], message: "Aggregate ranges are limited to 366 days", input: undefined }]));
    const result = await runTool(call("search_meal_history", { from: "2024-01-01", aggregate: true }), context({ meals: store }), newTurnState());
    expect(result).toMatchObject({ isError: true, output: { error: "Invalid arguments: to: Aggregate ranges are limited to 366 days" } });
  });
});
