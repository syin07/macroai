import { randomUUID } from "node:crypto";
import type { Macros } from "@/types/api";
import type { FakeDb } from "./fake-db";

// Seeds saved meals straight into the in-memory database for history tests (src/lib/database/history.test.ts
// and tests/eval history cases). Totals are stored as given, like a meal already recalculated on save;
// each item gets an even share of the meal's totals.

export interface SeedMeal {
  name: string;
  consumed_at: string; // ISO instant with offset
  totals: Macros;
  items?: string[]; // food names; defaults to the meal name
  status?: "active" | "pending_deletion";
  deleted_at?: string;
}

export function seedMeals(db: FakeDb, userId: string, meals: readonly SeedMeal[]): string[] {
  return meals.map((meal) => {
    const id = randomUUID();
    const iso = new Date(meal.consumed_at).toISOString();
    const pending = meal.status === "pending_deletion";
    db.meals.push({
      id,
      user_id: userId,
      name: meal.name,
      consumed_at: iso,
      created_at: iso,
      updated_at: iso,
      source_type: "text",
      total_calories: meal.totals.calories,
      total_protein_g: meal.totals.protein_g,
      total_carbs_g: meal.totals.carbs_g,
      total_fat_g: meal.totals.fat_g,
      status: meal.status ?? "active",
      deleted_at: pending ? (meal.deleted_at ?? new Date().toISOString()) : null,
      version: 1,
    });
    const names = meal.items ?? [meal.name];
    names.forEach((food_name, position) => {
      const share = 1 / names.length;
      db.meal_items.push({
        id: randomUUID(),
        meal_id: id,
        position,
        food_name,
        quantity: 1,
        unit: "serving",
        grams: null,
        basis_per_100g: null,
        calories: meal.totals.calories * share,
        protein_g: meal.totals.protein_g * share,
        carbs_g: meal.totals.carbs_g * share,
        fat_g: meal.totals.fat_g * share,
        nutrition_source: "ai",
        source_reference: null,
        inferred: false,
        confidence: "medium",
        edited_by_user: false,
        assumptions: null,
      });
    });
    return id;
  });
}
