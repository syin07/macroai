import { describe, expect, it } from "vitest";
import { fixtureLookup } from "./__fixtures__/fixture-client";
import {
  classifyFood,
  gramsFromDefaults,
  gramsFromTable,
  gramsFromUsda,
  isMassUnit,
  normalizeUnit,
  resolveGrams,
  type UsdaPortionData,
} from "./units";

const input = (quantity: number, unit: string, foodName: string) => ({ quantity, unit, foodName });

async function usdaPortions(fdcId: number): Promise<UsdaPortionData> {
  const food = await fixtureLookup({}).lookup.getFood(fdcId);
  if (!food) throw new Error(`missing fixture for ${fdcId}`);
  return { portions: food.portions, serving: food.serving };
}

describe("normalizeUnit", () => {
  it.each([
    ["g", "g"], ["Grams", "g"], ["oz", "oz"], ["ounces", "oz"], ["lbs", "lb"], ["kg", "kg"],
    ["mL", "ml"], ["litre", "l"], ["fl. oz.", "fl_oz"], ["fluid ounces", "fl_oz"],
    ["Cups", "cup"], ["Tablespoons", "tbsp"], ["tbs", "tbsp"], ["tsp", "tsp"], ["teaspoons", "tsp"],
    ["slices", "slice"], ["scoops", "scoop"], ["handfuls", "handful"], ["bowls", "bowl"],
    ["", "piece"], ["each", "piece"], ["pieces", "piece"], ["whole", "piece"],
    ["Medium", "medium"], ["lg", "large"], ["extra large", "extra large"], ["jumbo", "extra large"],
    ["NLEA serving", "serving"], ["bottles", "bottle"],
    ["eggs", "egg"], ["Bananas", "banana"],
  ])("%j → %s", (raw, expected) => {
    expect(normalizeUnit(raw)).toBe(expected);
  });

  it("does not treat Object.prototype names as units", () => {
    expect(normalizeUnit("constructor")).toBe("constructor");
    expect(isMassUnit("constructor")).toBe(false);
    expect(gramsFromTable(input(1, "constructor", "egg"))).toBeNull();
    expect(gramsFromDefaults(input(1, "toString", "egg"))).toBeNull();
  });
});

describe("classifyFood", () => {
  it.each([
    ["Peanut butter", "nut_butter"],
    ["Butter", "butter"],
    ["Almond milk", "liquid"],
    ["Almonds", "nuts"],
    ["Cooked white rice", "grain"],
    ["Spaghetti", "pasta"],
    ["Oatmeal", "porridge"],
    ["Dry oatmeal", "oats_dry"],
    ["Rolled oats", "oats_dry"],
    ["Whey protein powder", "protein_powder"],
    ["Vanilla ice cream", "ice_cream"],
    ["Greek yogurt", "yogurt"],
    ["Olive oil", "oil"],
    ["Blueberries", "fruit"],
    ["Baby spinach", "leafy_greens"],
    ["Black beans", "beans"],
    ["Chicken soup", "soup"],
    ["Grilled chicken breast", "generic"],
  ])("%s → %s", (name, kind) => {
    expect(classifyFood(name)).toBe(kind);
  });
});

describe("gramsFromTable", () => {
  it("passes grams through with no assumption", () => {
    expect(gramsFromTable(input(150, "g", "chicken"))).toEqual({ grams: 150, source: "mass", note: null });
  });

  it.each([
    [2, "oz", 56.699],
    [1, "lb", 453.592],
    [0.25, "kg", 250],
  ])("converts %d %s exactly", (quantity, unit, grams) => {
    const result = gramsFromTable(input(quantity, unit, "anything"));
    expect(result?.source).toBe("mass");
    expect(result?.grams).toBeCloseTo(grams, 6);
  });

  it.each([
    [1, "cup", "Cooked white rice", 160],
    [0.5, "cup", "Greek yogurt", 122.5],
    [1, "cup", "Milk", 240],
    [1, "cup", "Baby spinach", 30],
    [2, "tbsp", "Olive oil", 27.25],
    [1, "tsp", "Olive oil", 218 / 48],
    [1, "tbsp", "Peanut butter", 16.125],
    [250, "ml", "Orange juice", 250],
    [1, "bowl", "Oatmeal", 351],
  ])("%d %s of %s ≈ %d g (by food kind)", (quantity, unit, food, grams) => {
    const result = gramsFromTable(input(quantity, unit, food));
    expect(result?.source).toBe("table");
    expect(result?.grams).toBeCloseTo(grams, 6);
  });

  it.each([
    [2, "eggs", "Scrambled eggs", 100],
    [1, "", "Apple", 182],
    [1, "piece", "Banana", 118],
    [1, "whole", "Avocado", 136],
    [1, "piece", "Sweet potato", 130],
    [2, "slices", "Whole wheat toast", 56],
    [1, "slice", "Pepperoni pizza", 107],
    [3, "slices", "Bacon", 24],
    [1, "scoop", "Whey protein powder", 30],
    [2, "scoops", "Chocolate ice cream", 132],
    [1, "handful", "Almonds", 28],
  ])("%d %s of %s ≈ %d g (informal units)", (quantity, unit, food, grams) => {
    expect(gramsFromTable(input(quantity, unit, food))?.grams).toBeCloseTo(grams, 6);
  });

  it("explains the assumption", () => {
    expect(gramsFromTable(input(2, "tbsp", "Olive oil"))?.note).toBe("2 tbsp ≈ 27.3 g (typical for oil)");
    expect(gramsFromTable(input(1, "bowl", "Oatmeal"))?.note).toBe("1 bowl ≈ 351 g (bowl ≈ 1.5 cups of cooked oatmeal)");
  });

  it.each([
    ["a cup of an unknown kind of food", input(1, "cup", "Grilled chicken breast")],
    ["a slice of something not in the table", input(1, "slice", "Watermelon")],
    ["a scoop of rice", input(1, "scoop", "Rice")],
    ["a size word (USDA has size-specific data)", input(1, "large", "Banana")],
    ["a serving", input(1, "serving", "Granola bar")],
    ["zero quantity", input(0, "g", "Rice")],
    ["negative quantity", input(-1, "cup", "Rice")],
    ["NaN quantity", input(Number.NaN, "g", "Rice")],
  ])("returns null for %s", (_label, portion) => {
    expect(gramsFromTable(portion)).toBeNull();
  });
});

describe("gramsFromUsda", () => {
  it("uses the matching USDA portion", async () => {
    const rice = await usdaPortions(168930);
    expect(gramsFromUsda(input(1.5, "cups", "rice"), rice)).toEqual({
      grams: 279,
      source: "usda_portion",
      note: "1.5 cups ≈ 279 g (USDA: 1 cup = 186 g)",
    });
  });

  it("derives other volumes from a USDA volume portion", async () => {
    const rice = await usdaPortions(168930);
    expect(gramsFromUsda(input(2, "tbsp", "rice"), rice)?.grams).toBeCloseTo(23.25, 6);
  });

  it("matches size words exactly, not their extra- variants", async () => {
    const banana = await usdaPortions(173944);
    expect(gramsFromUsda(input(1, "small", "banana"), banana)?.grams).toBe(101);
    expect(gramsFromUsda(input(1, "large", "banana"), banana)?.grams).toBe(136);
    expect(gramsFromUsda(input(1, "extra large", "banana"), banana)?.grams).toBe(152);
    expect(gramsFromUsda(input(2, "medium", "banana"), banana)?.grams).toBe(236);
  });

  it("treats a plain count as a USDA piece or medium portion", async () => {
    const srChicken = await usdaPortions(171534);
    expect(gramsFromUsda(input(1, "piece", "Grilled chicken breast"), srChicken)?.grams).toBe(196);
    const fnddsChicken = await usdaPortions(2705968);
    expect(gramsFromUsda(input(1, "piece", "Grilled chicken breast"), fnddsChicken)?.grams).toBe(120);
    expect(gramsFromUsda(input(1, "small", "Grilled chicken breast"), fnddsChicken)?.grams).toBe(105);
  });

  it("reads the unit from FNDDS phrases like 'small or thin slice'", async () => {
    const fnddsChicken = await usdaPortions(2705968);
    expect(gramsFromUsda(input(2, "slices", "Chicken breast"), fnddsChicken)?.grams).toBe(60);
  });

  it("uses the label serving for containers of branded foods", async () => {
    const shake = await usdaPortions(1935189);
    expect(gramsFromUsda(input(1, "bottle", "Core Power shake"), shake)).toEqual({
      grams: 340,
      source: "serving",
      note: "1 bottle ≈ 340 g (label serving: 11.5 OZA, 340 ml)",
    });
    expect(gramsFromUsda(input(2, "servings", "Core Power shake"), shake)?.grams).toBe(680);
  });

  it("returns null when USDA has no matching portion", async () => {
    const rice = await usdaPortions(168930);
    expect(gramsFromUsda(input(1, "slice", "rice"), rice)).toBeNull();
    expect(gramsFromUsda(input(1, "bottle", "rice"), rice)).toBeNull();
  });
});

describe("gramsFromDefaults", () => {
  it("assumes water density for volumes", () => {
    expect(gramsFromDefaults(input(1, "cup", "Mystery stew"))).toEqual({
      grams: 240,
      source: "default",
      note: "1 cup ≈ 240 g (assumed density of water)",
    });
  });

  it("uses a generic handful", () => {
    expect(gramsFromDefaults(input(2, "handfuls", "Trail snacks"))?.grams).toBe(60);
  });

  it("uses the standard item weight for a size word, saying so", () => {
    expect(gramsFromDefaults(input(1, "large", "Egg"))).toEqual({
      grams: 50,
      source: "default",
      note: "1 large ≈ 50 g (typical egg; size not adjusted)",
    });
  });

  it("gives up on units it can't estimate", () => {
    expect(gramsFromDefaults(input(1, "piece", "Mystery casserole"))).toBeNull();
    expect(gramsFromDefaults(input(1, "serving", "Granola bar"))).toBeNull();
  });
});

describe("resolveGrams", () => {
  it("prefers the table over USDA portion data", async () => {
    const rice = await usdaPortions(168930);
    expect(resolveGrams(input(1, "cup", "Cooked white rice"), rice)).toMatchObject({ grams: 160, source: "table" });
  });

  it("lets USDA fill gaps in the table", async () => {
    const chicken = await usdaPortions(171534);
    expect(resolveGrams(input(1, "piece", "Grilled chicken breast"), chicken)).toMatchObject({ grams: 196, source: "usda_portion" });
  });

  it("falls back to defaults last", async () => {
    const chicken = await usdaPortions(171534);
    expect(resolveGrams(input(1, "cup", "Grilled chicken breast"), chicken)).toMatchObject({ grams: 240, source: "default" });
    expect(resolveGrams(input(1, "cup", "Grilled chicken breast"))).toMatchObject({ source: "default" });
  });

  it("returns null when nothing applies", () => {
    expect(resolveGrams(input(1, "piece", "Mystery casserole"))).toBeNull();
  });
});
