import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createFakeDb, fakeClient } from "@/lib/database/__fixtures__/fake-db";
import { seedMeals } from "@/lib/database/__fixtures__/history-seed";
import { editMeal } from "@/lib/database/meal-writes";
import type { MealAnalysis } from "./analyze";
import { createMealStore } from "./meal-store";
import { newTurnState, runTool, type ToolContext } from "./tools";

// The update_meal version race on the real adapter, not a stubbed store: tool → createMealStore →
// editMeal → the update_meal SQL function (emulated by fake-db with the same version check and the
// same revision insert after it). With no meal_id the tool picks the meal from recent history and
// writes with the version it read there; a user PATCH that commits in either window (before editMeal's
// own read, or between that read and the SQL write) must reject the write, keep the user's edit, and
// leave no revision row behind.

const USER = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-26T19:00:00Z");
const TZ = "America/Los_Angeles";

function setup() {
  const db = createFakeDb();
  const [mealId] = seedMeals(db, USER, [
    {
      name: "Cheeseburger",
      consumed_at: "2026-10-26T12:15:00-07:00",
      totals: { calories: 600, protein_g: 30, carbs_g: 40, fat_g: 33 },
      items: ["Hamburger bun", "American cheese", "Beef patty"],
    },
  ]);
  const supabase = fakeClient(db, { userId: USER });
  const store = createMealStore(supabase, USER, TZ, () => NOW);
  const ctx: ToolContext = {
    userId: USER,
    supabase,
    now: NOW,
    timezone: TZ,
    saveMode: "confirm",
    analyze: vi.fn(async (): Promise<MealAnalysis> => {
      throw new Error("not used");
    }),
    lookup: { searchFoods: vi.fn(async () => []), getFood: vi.fn(async () => null) },
    meals: store,
    memory: null,
    priorProposals: new Map(),
  };
  const row = () => db.meals.find((meal) => meal.id === mealId)!;
  const foods = () => db.meal_items.filter((item) => item.meal_id === mealId).map((item) => item.food_name);
  return { db, supabase, store, ctx, mealId: mealId!, row, foods };
}

// "Take the cheese off": no meal_id, so the tool resolves the meal from recent history.
const removeCheese = () => ({ id: randomUUID(), name: "update_meal", input: { item_changes: [{ food_name: "cheese", remove: true }] } });

describe("update_meal without a meal_id, through createMealStore and editMeal", () => {
  it("writes with the version it read and succeeds when nothing else touched the meal", async () => {
    const { db, supabase, ctx, mealId, row, foods } = setup();
    const rpc = vi.spyOn(supabase, "rpc");
    const state = newTurnState();
    const result = await runTool(removeCheese(), ctx, state);

    expect(result.isError).toBeFalsy();
    expect(result.output).toMatchObject({ status: "updated", meal_id: mealId, version: 2 });
    expect(rpc).toHaveBeenCalledWith("update_meal", expect.objectContaining({ p_meal_id: mealId, p_version: 1 }));
    expect(row()).toMatchObject({ version: 2 });
    expect(foods()).toEqual(["Hamburger bun", "Beef patty"]);
    expect(db.meal_revisions.filter((rev) => rev.meal_id === mealId)).toHaveLength(1);
    expect(state.mealChanged).toBe(true);
  });

  it("a user PATCH that commits after the tool read recent history is rejected by editMeal's version check", async () => {
    const { db, supabase, store, ctx, mealId, row, foods } = setup();
    const recent = store.recentMeals;
    store.recentMeals = async (limit) => {
      const seen = await recent(limit); // the tool's read: version 1
      await editMeal(supabase, USER, mealId, { version: 1, name: "Renamed in the app" }); // the user's PATCH: version 2
      return seen;
    };
    const rpc = vi.spyOn(supabase, "rpc");
    const state = newTurnState();
    const result = await runTool(removeCheese(), ctx, state);

    expect(result.isError).toBe(true);
    expect(result.output).toMatchObject({
      error: expect.stringContaining("edited after version 1 and is now version 2"),
      current_meal: { meal_id: mealId, version: 2, name: "Renamed in the app" },
    });
    // The only write that reached the SQL function is the user's rename: editMeal's pre-check stopped
    // the tool's (which would have carried p_items) before the function was called.
    expect(rpc.mock.calls.filter(([name]) => name === "update_meal")).toEqual([
      ["update_meal", expect.objectContaining({ p_meal_id: mealId, p_version: 1, p_name: "Renamed in the app", p_items: null })],
    ]);
    // The user's edit stands, the cheese is still there, and the only revision is the user's.
    expect(row()).toMatchObject({ name: "Renamed in the app", version: 2 });
    expect(foods()).toEqual(["Hamburger bun", "American cheese", "Beef patty"]);
    expect(db.meal_revisions.filter((rev) => rev.meal_id === mealId)).toHaveLength(1);
    expect(state.cards).toEqual([]);
    expect(state.mealChanged).toBe(false);
    expect(state.meals.size).toBe(0);
  });

  it("a user PATCH that commits between editMeal's read and the SQL write is rejected by the row-locked check, with no revision row", async () => {
    const { db, supabase, ctx, mealId, row, foods } = setup();
    // fake-db runs beforeRpc just before the function body, i.e. inside the window the SQL row lock covers.
    db.beforeRpc = (name) => {
      if (name !== "update_meal") return;
      row().name = "Renamed in the app";
      row().version = 2;
    };
    const rpc = vi.spyOn(supabase, "rpc");
    const state = newTurnState();
    const result = await runTool(removeCheese(), ctx, state);

    expect(result.isError).toBe(true);
    expect(result.output).toMatchObject({
      error: expect.stringContaining("edited after version 1 and is now version 2"),
      current_meal: { meal_id: mealId, version: 2, name: "Renamed in the app" },
    });
    // Exactly one write attempt, conditioned on the version the tool read.
    expect(rpc.mock.calls.filter(([name]) => name === "update_meal")).toEqual([
      ["update_meal", expect.objectContaining({ p_meal_id: mealId, p_version: 1 })],
    ]);
    expect(row()).toMatchObject({ name: "Renamed in the app", version: 2 });
    expect(foods()).toEqual(["Hamburger bun", "American cheese", "Beef patty"]);
    expect(db.meal_revisions).toEqual([]);
    expect(state.cards).toEqual([]);
    expect(state.mealChanged).toBe(false);
  });
});
