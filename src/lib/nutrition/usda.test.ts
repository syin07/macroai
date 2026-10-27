import { describe, expect, it } from "vitest";
import { macrosSchema } from "@/lib/validation";
import { fixtureLookup } from "./__fixtures__/fixture-client";
import { BRANDED_DATA_TYPES, GENERIC_DATA_TYPES, UsdaError, createUsdaClient, toBasis, toPortion } from "./usda";

// All responses come from recorded fixtures (__fixtures__/usda); nothing here calls the network.

const SEARCHES = {
  "chicken breast grilled": "search-chicken-breast-grilled",
  "rice white cooked": "search-rice-white-cooked",
  banana: "search-banana",
  "fairlife core power protein shake": "search-fairlife-core-power",
};

describe("searchFoods", () => {
  it("POSTs the query with the key in a header, never the URL", async () => {
    const { lookup, requests } = fixtureLookup(SEARCHES);
    await lookup.searchFoods("chicken breast grilled");

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request!.method).toBe("POST");
    expect(request!.url).toBe("https://api.nal.usda.gov/fdc/v1/foods/search");
    expect(request!.url).not.toContain("TEST_KEY");
    expect(request!.headers.get("X-Api-Key")).toBe("TEST_KEY");
    expect(request!.body).toEqual({ query: "chicken breast grilled", dataType: GENERIC_DATA_TYPES, pageSize: 25 });
  });

  it("passes data types and page size through", async () => {
    const { lookup, requests } = fixtureLookup(SEARCHES);
    await lookup.searchFoods("fairlife core power protein shake", { dataTypes: BRANDED_DATA_TYPES, pageSize: 5 });
    expect(requests[0]!.body).toEqual({ query: "fairlife core power protein shake", dataType: ["Branded"], pageSize: 5 });
  });

  it("normalizes generic foods to per-100 g macros", async () => {
    const { lookup } = fixtureLookup(SEARCHES);
    const foods = await lookup.searchFoods("chicken breast grilled");

    expect(foods).toHaveLength(25);
    expect(foods.find((f) => f.fdcId === 171534)).toEqual({
      fdcId: 171534,
      description: "Chicken, broiler or fryers, breast, skinless, boneless, meat only, cooked, grilled",
      dataType: "SR Legacy",
      brand: null,
      basis_per_100g: { calories: 151, protein_g: 30.5, carbs_g: 0, fat_g: 3.17 },
      portions: [],
      serving: null,
    });
    for (const food of foods) {
      if (food.basis_per_100g) expect(macrosSchema.safeParse(food.basis_per_100g).success).toBe(true);
    }
  });

  it("leaves basis null when the record has no usable nutrients", async () => {
    const { lookup } = fixtureLookup(SEARCHES);
    const foods = await lookup.searchFoods("chicken breast grilled");
    // Foundation "Lunchmeat, chicken breast, sliced" was recorded with no energy or macros.
    expect(foods.find((f) => f.fdcId === 2759004)?.basis_per_100g).toBeNull();
  });

  it("prefers carbohydrate by difference (1005) over by summation (1050)", async () => {
    const { lookup } = fixtureLookup(SEARCHES);
    const foods = await lookup.searchFoods("banana");
    // Foundation "Bananas, overripe, raw" reports both: 20.1 g by difference, 18 g by summation.
    expect(foods.find((f) => f.fdcId === 1105073)?.basis_per_100g).toEqual({
      calories: 85,
      protein_g: 0.73,
      carbs_g: 20.1,
      fat_g: 0.22,
    });
  });

  it("keeps brand and label serving for branded foods", async () => {
    const { lookup } = fixtureLookup(SEARCHES);
    const foods = await lookup.searchFoods("fairlife core power protein shake", { dataTypes: BRANDED_DATA_TYPES });

    const shake = foods.find((f) => f.fdcId === 1935189);
    expect(shake?.brand).toBe("CORE POWER (Fair Oaks Farms Brands, Inc.)");
    expect(shake?.serving).toEqual({ amount: 340, unit: "ml", household: "11.5 OZA" });
    expect(shake?.basis_per_100g).toEqual({ calories: 71, protein_g: 7.65, carbs_g: 7.65, fat_g: 1.03 });

    // "MLT" is FDC's code for millilitres.
    expect(foods.find((f) => f.fdcId === 2742751)?.serving).toEqual({ amount: 414, unit: "ml", household: "1 Bottle" });
  });

  it("returns no foods when nothing matches", async () => {
    const { lookup } = fixtureLookup(SEARCHES);
    expect(await lookup.searchFoods("nothing recorded for this")).toEqual([]);
  });
});

describe("getFood", () => {
  it("normalizes an SR Legacy food with portions, ignoring kJ energy", async () => {
    const { lookup, requests } = fixtureLookup({});
    const rice = await lookup.getFood(168930);

    expect(requests[0]!.url).toBe("https://api.nal.usda.gov/fdc/v1/food/168930");
    expect(requests[0]!.headers.get("X-Api-Key")).toBe("TEST_KEY");
    expect(rice).toEqual({
      fdcId: 168930,
      description: "Rice, white, medium-grain, cooked, unenriched",
      dataType: "SR Legacy",
      brand: null,
      basis_per_100g: { calories: 130, protein_g: 2.38, carbs_g: 28.59, fat_g: 0.21 },
      portions: [{ amount: 1, unit: "cup", gramWeight: 186 }],
      serving: null,
    });
  });

  it("orders portions by USDA sequence number", async () => {
    const { lookup } = fixtureLookup({});
    const banana = await lookup.getFood(173944);
    expect(banana?.portions.map((p) => [p.unit, p.gramWeight])).toEqual([
      ["cup, mashed", 225],
      ["cup, sliced", 150],
      ['extra small (less than 6" long)', 81],
      ['small (6" to 6-7/8" long)', 101],
      ['medium (7" to 7-7/8" long)', 118],
      ['large (8" to 8-7/8" long)', 136],
      ['extra large (9" or longer)', 152],
      ["NLEA serving", 126],
    ]);
  });

  it("reads FNDDS portions from portionDescription and drops unquantified ones", async () => {
    const { lookup } = fixtureLookup({});
    const chicken = await lookup.getFood(2705968);

    expect(chicken?.basis_per_100g).toEqual({ calories: 176, protein_g: 29.6, carbs_g: 0, fat_g: 5.45 });
    // 10 recorded portions; "Quantity not specified" has no amount and is dropped.
    expect(chicken?.portions).toHaveLength(9);
    expect(chicken?.portions[0]).toEqual({ amount: 1, unit: "cup, cooked, diced", gramWeight: 135 });
    expect(chicken?.portions).toContainEqual({ amount: 1, unit: "medium breast", gramWeight: 120 });
  });

  it("normalizes a branded food", async () => {
    const { lookup } = fixtureLookup({});
    const shake = await lookup.getFood(1935189);
    expect(shake).toMatchObject({
      dataType: "Branded",
      brand: "CORE POWER (Fair Oaks Farms Brands, Inc.)",
      basis_per_100g: { calories: 71, protein_g: 7.65, carbs_g: 7.65, fat_g: 1.03 },
      portions: [],
      serving: { amount: 340, unit: "ml", household: "11.5 OZA" },
    });
  });

  it("returns null for unknown or invalid IDs", async () => {
    const { lookup, requests } = fixtureLookup({});
    expect(await lookup.getFood(1)).toBeNull();
    expect(await lookup.getFood(-5)).toBeNull();
    expect(await lookup.getFood(1.5)).toBeNull();
    expect(requests).toHaveLength(1); // invalid IDs never reach the network
  });
});

describe("errors", () => {
  const clientWith = (fetchImpl: typeof fetch) => createUsdaClient({ apiKey: "SECRET_KEY", fetch: fetchImpl });

  async function caught(promise: Promise<unknown>): Promise<UsdaError> {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UsdaError);
    expect((error as Error).message).not.toContain("SECRET_KEY");
    return error as UsdaError;
  }

  it("maps 429 to rate_limited", async () => {
    const error = await caught(clientWith((async () => new Response("", { status: 429 })) as typeof fetch).searchFoods("x"));
    expect(error.kind).toBe("rate_limited");
  });

  it("maps other HTTP failures to http", async () => {
    const error = await caught(clientWith((async () => new Response("", { status: 503 })) as typeof fetch).getFood(5));
    expect(error).toMatchObject({ kind: "http", status: 503 });
  });

  it("maps timeouts to timeout", async () => {
    const timeout = async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    };
    const error = await caught(clientWith(timeout as typeof fetch).searchFoods("x"));
    expect(error.kind).toBe("timeout");
  });

  it("maps network failures to http", async () => {
    const offline = async () => {
      throw new TypeError("fetch failed");
    };
    expect((await caught(clientWith(offline as typeof fetch).searchFoods("x"))).kind).toBe("http");
  });

  it("rejects responses that don't look like FDC data", async () => {
    const weird = (async () => Response.json({ foods: [{ fdcId: "abc" }] })) as typeof fetch;
    expect((await caught(clientWith(weird).searchFoods("x"))).kind).toBe("invalid_response");
    const notJson = (async () => new Response("<html>")) as typeof fetch;
    expect((await caught(clientWith(notJson).getFood(5))).kind).toBe("invalid_response");
  });
});

describe("toBasis", () => {
  const macros = [
    { id: 1003, unit: "G", value: 10 },
    { id: 1004, unit: "G", value: 5 },
    { id: 1005, unit: "G", value: 20 },
  ];

  it("uses energy 1008, then Atwater specific (2048), then Atwater general (2047)", () => {
    const atwater = [{ id: 2047, unit: "KCAL", value: 160 }, { id: 2048, unit: "KCAL", value: 155 }];
    expect(toBasis([...macros, ...atwater, { id: 1008, unit: "KCAL", value: 150 }])?.calories).toBe(150);
    expect(toBasis([...macros, ...atwater])?.calories).toBe(155);
    expect(toBasis([...macros, atwater[0]!])?.calories).toBe(160);
  });

  it("never reads kJ as kcal", () => {
    expect(toBasis([...macros, { id: 1062, unit: "kJ", value: 600 }])).toBeNull();
    expect(toBasis([...macros, { id: 1008, unit: "kJ", value: 600 }])).toBeNull();
  });

  it("falls back to carbohydrate by summation", () => {
    const withoutDifference = macros.filter((m) => m.id !== 1005);
    expect(toBasis([...withoutDifference, { id: 1050, unit: "G", value: 18 }, { id: 1008, unit: "KCAL", value: 1 }])?.carbs_g).toBe(18);
  });

  it("is null when a macro is missing rather than guessing zero", () => {
    expect(toBasis([{ id: 1008, unit: "KCAL", value: 100 }, ...macros.slice(1)])).toBeNull();
  });

  it("clamps tiny negative values", () => {
    const basis = toBasis([{ id: 1008, unit: "KCAL", value: 9 }, { id: 1003, unit: "G", value: 0 }, { id: 1004, unit: "G", value: 1 }, { id: 1005, unit: "G", value: -0.2 }]);
    expect(basis).toEqual({ calories: 9, protein_g: 0, carbs_g: 0, fat_g: 1 });
  });
});

describe("toPortion", () => {
  it.each([
    ["SR Legacy modifier", { amount: 1, gramWeight: 158, modifier: "cup", measureUnit: { name: "undetermined" } }, { amount: 1, unit: "cup", gramWeight: 158 }],
    ["Foundation measure unit + modifier", { amount: 1, gramWeight: 30, modifier: "chopped", measureUnit: { name: "cup" } }, { amount: 1, unit: "cup, chopped", gramWeight: 30 }],
    ["FNDDS description", { gramWeight: 120, modifier: "64699", portionDescription: "1 medium breast", measureUnit: { name: "undetermined" } }, { amount: 1, unit: "medium breast", gramWeight: 120 }],
    ["FNDDS fraction", { gramWeight: 79, modifier: "10205", portionDescription: "1/2 cup" }, { amount: 0.5, unit: "cup", gramWeight: 79 }],
  ])("%s", (_label, raw, expected) => {
    expect(toPortion(raw)).toEqual(expected);
  });

  it.each([
    ["no weight", { amount: 1, gramWeight: 0, modifier: "cup" }],
    ["no amount", { gramWeight: 120, portionDescription: "Quantity not specified" }],
    ["no unit", { amount: 1, gramWeight: 50, modifier: "12345" }],
  ])("drops portions with %s", (_label, raw) => {
    expect(toPortion(raw)).toBeNull();
  });
});
