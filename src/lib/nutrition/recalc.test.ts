import { describe, expect, it } from "vitest";
import type { MealItem } from "@/types/api";
import { itemChanged, markUserEdits, OversizedItemError, recalculateMeal } from "./recalc";

const stored: MealItem = {
  id: "a0000000-0000-4000-8000-000000000001",
  food_name: "banana",
  quantity: 1,
  unit: "medium",
  grams: 118,
  basis_per_100g: { calories: 89, protein_g: 1.09, carbs_g: 22.84, fat_g: 0.33 },
  macros: { calories: 105.02, protein_g: 1.286, carbs_g: 26.951, fat_g: 0.389 }, // as stored, numeric(10,3)
  nutrition_source: "usda",
  source_reference: "173944",
  inferred: false,
  confidence: null,
  edited_by_user: false,
  assumptions: null,
};

describe("recalculateMeal", () => {
  it("derives macros from the basis and recomputes totals, unrounded", () => {
    const { items, totals } = recalculateMeal([
      { ...stored, macros: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 } },
      { ...stored, basis_per_100g: null, grams: null, macros: { calories: 10, protein_g: 1, carbs_g: 1, fat_g: 1 } },
    ]);
    expect(items[0]!.macros.protein_g).toBeCloseTo(1.2862, 10);
    expect(items[1]!.macros).toEqual({ calories: 10, protein_g: 1, carbs_g: 1, fat_g: 1 });
    expect(totals.calories).toBeCloseTo(115.02, 10);
  });

  it("throws OversizedItemError with the item index past the sanity caps", () => {
    const huge = { ...stored, grams: 10_000, basis_per_100g: { calories: 50_000, protein_g: 0, carbs_g: 0, fat_g: 0 } };
    expect(() => recalculateMeal([stored, huge])).toThrow(OversizedItemError);
    try {
      recalculateMeal([stored, huge]);
    } catch (error) {
      expect((error as OversizedItemError).index).toBe(1);
    }
  });
});

describe("markUserEdits", () => {
  it("doesn't count a re-derived value that differs only below storage precision", () => {
    const [rederived] = recalculateMeal([stored]).items; // protein 1.2862 vs stored 1.286
    expect(itemChanged(rederived!, stored)).toBe(false);
    expect(markUserEdits([rederived!], [stored])[0]!.edited_by_user).toBe(false);
  });

  it("marks changed, new, and previously edited items", () => {
    const changed = { ...stored, grams: 150 };
    const added = { ...stored, id: null };
    const previouslyEdited = { ...stored, id: "a0000000-0000-4000-8000-000000000002" };
    const result = markUserEdits(
      [changed, added, previouslyEdited],
      [stored, { ...previouslyEdited, edited_by_user: true }],
    );
    expect(result.map((item) => item.edited_by_user)).toEqual([true, true, true]);
  });

  it.each([
    ["food_name", { food_name: "plantain" }],
    ["unit", { unit: "large" }],
    ["quantity", { quantity: 2 }],
    ["source", { nutrition_source: "manual" as const }],
    ["macros", { macros: { ...stored.macros, calories: 120 } }],
  ])("treats a different %s as an edit", (_field, change) => {
    expect(itemChanged({ ...stored, ...change }, stored)).toBe(true);
  });
});
