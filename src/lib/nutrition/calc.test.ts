import { describe, expect, it } from "vitest";
import type { Macros } from "@/types/api";
import {
  ZERO_MACROS,
  itemMacros,
  mealTotals,
  remaining,
  resizeItem,
  round1,
  round1Macros,
  scaleMacros,
  sumMacros,
  withDerivedMacros,
} from "./calc";

// USDA SR Legacy 171534, grilled chicken breast, per 100 g.
const chicken: Macros = { calories: 151, protein_g: 30.54, carbs_g: 0, fat_g: 3.17 };
// USDA SR Legacy 168930, cooked white rice, per 100 g.
const rice: Macros = { calories: 130, protein_g: 2.38, carbs_g: 28.59, fat_g: 0.21 };

function expectMacrosClose(actual: Macros, expected: Macros) {
  expect(actual.calories).toBeCloseTo(expected.calories, 9);
  expect(actual.protein_g).toBeCloseTo(expected.protein_g, 9);
  expect(actual.carbs_g).toBeCloseTo(expected.carbs_g, 9);
  expect(actual.fat_g).toBeCloseTo(expected.fat_g, 9);
}

describe("itemMacros", () => {
  it("scales the per-100 g basis by grams / 100", () => {
    expectMacrosClose(itemMacros(chicken, 150), { calories: 226.5, protein_g: 45.81, carbs_g: 0, fat_g: 4.755 });
    expectMacrosClose(itemMacros(rice, 100), rice);
  });

  it.each([1, 37.5, 150, 333.3, 2000])("doubling %d g doubles every macro", (grams) => {
    expectMacrosClose(itemMacros(chicken, grams * 2), scaleMacros(itemMacros(chicken, grams), 2));
    expectMacrosClose(itemMacros(rice, grams * 2), scaleMacros(itemMacros(rice, grams), 2));
  });

  it("returns zero for zero grams", () => {
    expect(itemMacros(chicken, 0)).toEqual(ZERO_MACROS);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("rejects %d grams", (grams) => {
    expect(() => itemMacros(chicken, grams)).toThrow(RangeError);
  });

  it("does not round", () => {
    expect(itemMacros(rice, 33).protein_g).toBeCloseTo(0.7854, 12);
  });
});

describe("sumMacros / mealTotals", () => {
  it("sums nothing to zero", () => {
    expect(sumMacros([])).toEqual(ZERO_MACROS);
    expect(mealTotals([])).toEqual(ZERO_MACROS);
  });

  it("meal total equals the sum of its items", () => {
    const items = [{ macros: itemMacros(chicken, 150) }, { macros: itemMacros(rice, 200) }, { macros: itemMacros(rice, 45) }];
    const total = mealTotals(items);
    expectMacrosClose(total, {
      calories: 226.5 + 260 + 58.5,
      protein_g: 45.81 + 4.76 + 1.071,
      carbs_g: 0 + 57.18 + 12.8655,
      fat_g: 4.755 + 0.42 + 0.0945,
    });
    // Same answer in any order.
    expectMacrosClose(mealTotals([...items].reverse()), total);
  });

  it("does not mutate ZERO_MACROS", () => {
    sumMacros([chicken]);
    expect(ZERO_MACROS).toEqual({ calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
  });
});

describe("rounding happens only at display", () => {
  it("totals keep full precision, so rounding the total differs from summing rounded items", () => {
    // Ten 0.04 g items: rounding each first would show 0 g; the real total is 0.4 g.
    const items = Array.from({ length: 10 }, () => ({ macros: { calories: 0.44, protein_g: 0.04, carbs_g: 0, fat_g: 0 } }));
    const total = mealTotals(items);
    expect(total.protein_g).toBeCloseTo(0.4, 12);
    expect(round1(total.protein_g)).toBe(0.4);
    expect(items.reduce((sum, item) => sum + round1(item.macros.protein_g), 0)).toBe(0);
    expect(round1(total.calories)).toBe(4.4);
  });
});

describe("remaining", () => {
  const targets: Macros = { calories: 2000, protein_g: 150, carbs_g: 200, fat_g: 65 };

  it("is targets minus consumed", () => {
    expect(remaining({ calories: 1200, protein_g: 90, carbs_g: 120, fat_g: 40 }, targets)).toEqual({
      calories: 800,
      protein_g: 60,
      carbs_g: 80,
      fat_g: 25,
    });
  });

  it("goes negative when over target", () => {
    expect(remaining({ calories: 2350.5, protein_g: 160, carbs_g: 180, fat_g: 70 }, targets)).toEqual({
      calories: -350.5,
      protein_g: -10,
      carbs_g: 20,
      fat_g: -5,
    });
  });
});

describe("withDerivedMacros", () => {
  const clientMacros: Macros = { calories: 999, protein_g: 99, carbs_g: 99, fat_g: 99 };

  it("recomputes macros from basis × grams, ignoring client-sent values", () => {
    const item = withDerivedMacros({ basis_per_100g: chicken, grams: 200, macros: clientMacros });
    expectMacrosClose(item.macros, itemMacros(chicken, 200));
  });

  it("keeps given macros for items without a basis (manual / AI-only)", () => {
    const item = { basis_per_100g: null, grams: 120, macros: clientMacros };
    expect(withDerivedMacros(item)).toBe(item);
  });

  it("keeps given macros when grams are unknown", () => {
    const item = { basis_per_100g: chicken, grams: null, macros: clientMacros };
    expect(withDerivedMacros(item)).toBe(item);
  });
});

describe("round1", () => {
  it.each([
    [0, 0],
    [1.04, 1],
    [1.05, 1.1],
    [0.15, 0.2],
    [226.46, 226.5],
    [-1.25, -1.3],
    [-350.54, -350.5],
  ])("%d → %d", (value, expected) => {
    expect(round1(value)).toBe(expected);
  });

  it("never returns -0", () => {
    expect(Object.is(round1(-0.04), 0)).toBe(true);
  });

  it("rounds every field of a Macros", () => {
    expect(round1Macros(itemMacros(chicken, 150))).toEqual({ calories: 226.5, protein_g: 45.8, carbs_g: 0, fat_g: 4.8 });
  });
});

describe("resizeItem", () => {
  const riceCup = { quantity: 1, unit: "cup", grams: 160, basis_per_100g: rice, macros: itemMacros(rice, 160) };
  const aiPizza = {
    quantity: 2,
    unit: "slice",
    grams: 214,
    basis_per_100g: null,
    macros: { calories: 570, protein_g: 24, carbs_g: 70, fat_g: 20 },
  };

  it("re-derives macros from the basis when the weight changes (200 g of rice = 260 kcal)", () => {
    const resized = resizeItem(riceCup, { grams: 200 });
    expect(resized.grams).toBe(200);
    expect(resized.quantity).toBeCloseTo(1.25, 9);
    expectMacrosClose(resized.macros, { calories: 260, protein_g: 4.76, carbs_g: 57.18, fat_g: 0.42 });
  });

  it("scales weight and macros with a new quantity", () => {
    const resized = resizeItem(riceCup, { quantity: 0.5 });
    expect(resized.grams).toBe(80);
    expectMacrosClose(resized.macros, itemMacros(rice, 80));
  });

  it("scales AI-only estimates proportionally (I only ate one of the two slices)", () => {
    const resized = resizeItem(aiPizza, { quantity: 1 });
    expect(resized.grams).toBe(107);
    expectMacrosClose(resized.macros, { calories: 285, protein_g: 12, carbs_g: 35, fat_g: 10 });
  });

  it("refuses a new weight when there is nothing to scale from", () => {
    expect(() => resizeItem({ ...aiPizza, grams: null }, { grams: 100 })).toThrow(RangeError);
  });

  it("returns the item unchanged when no amount is given, and rejects negatives", () => {
    expect(resizeItem(riceCup, {})).toBe(riceCup);
    expect(() => resizeItem(riceCup, { grams: -1 })).toThrow(RangeError);
  });
});
