import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Macros } from "@/types/api";
import { fixtureLookup } from "./__fixtures__/fixture-client";
import {
  createSupabaseNutritionCache,
  fromCacheRow,
  nutritionCacheKey,
  toCacheRow,
  type NutritionCache,
} from "./cache";
import { matchFood, type ExtractedFood } from "./match";
import type { UsdaFood } from "./usda";

const food = (fields: Partial<ExtractedFood> & Pick<ExtractedFood, "name" | "search_query">): ExtractedFood => ({
  quantity: 150,
  unit: "g",
  preparation: null,
  inferred: false,
  confidence: "medium",
  ...fields,
});

const basis: Macros = { calories: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6 };
const grilledChickenFood: UsdaFood = {
  fdcId: 171534,
  description: "Chicken, broilers or fryers, breast, meat only, cooked, roasted",
  dataType: "SR Legacy",
  brand: null,
  basis_per_100g: basis,
  portions: [{ amount: 1, unit: "cup, chopped or diced", gramWeight: 140 }],
  serving: null,
};

const grilledChicken = food({ name: "Grilled chicken breast", search_query: "chicken breast, grilled", preparation: "grilled" });
const SEARCHES = { "chicken breast, grilled": "search-chicken-breast-grilled" };
const NOW = new Date("2026-10-25T12:00:00Z");

function memoryCache(initial: Record<string, UsdaFood> = {}) {
  const store = new Map(Object.entries(initial));
  const cache = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: UsdaFood) => void store.set(key, value)),
  } satisfies NutritionCache;
  return { cache, store };
}

describe("nutritionCacheKey", () => {
  it("ignores case, punctuation, and plurals", () => {
    const a = food({ name: "Grilled Chicken Breasts", search_query: "Chicken, breast, grilled", preparation: "Grilled" });
    const b = food({ name: "grilled chicken breast", search_query: "chicken breast grilled", preparation: "grilled" });
    expect(nutritionCacheKey(a)).toBe(nutritionCacheKey(b));
  });

  it("separates everything the matcher reads", () => {
    const base = nutritionCacheKey(grilledChicken);
    expect(nutritionCacheKey({ ...grilledChicken, preparation: "raw" })).not.toBe(base);
    expect(nutritionCacheKey({ ...grilledChicken, brand: "Tyson" })).not.toBe(base);
    expect(nutritionCacheKey({ ...grilledChicken, name: "Fried chicken breast" })).not.toBe(base);
    expect(nutritionCacheKey({ ...grilledChicken, search_query: "chicken thigh, grilled" })).not.toBe(base);
  });

  it("does not depend on the portion", () => {
    expect(nutritionCacheKey({ ...grilledChicken, quantity: 2, unit: "breast" })).toBe(nutritionCacheKey(grilledChicken));
  });
});

describe("cache rows", () => {
  it("round-trip a food", () => {
    const row = toCacheRow("k", grilledChickenFood, NOW);
    expect(row).toMatchObject({ query_key: "k", source: "usda", source_reference: "171534", per_100g: basis });
    expect(fromCacheRow(row, NOW)).toEqual(grilledChickenFood);
  });

  it("treat expired rows as a miss", () => {
    const row = toCacheRow("k", grilledChickenFood, new Date("2026-01-01T00:00:00Z"));
    expect(fromCacheRow(row, NOW, 365)).not.toBeNull();
    expect(fromCacheRow(row, NOW, 180)).toBeNull();
  });

  it("treat malformed rows as a miss", () => {
    const row = toCacheRow("k", grilledChickenFood, NOW);
    expect(fromCacheRow({ ...row, per_100g: { calories: 100 } }, NOW)).toBeNull();
    expect(fromCacheRow({ ...row, portions: null }, NOW)).toBeNull();
    expect(fromCacheRow({ ...row, source_reference: "https://example.com" }, NOW)).toBeNull();
    expect(fromCacheRow(null, NOW)).toBeNull();
  });

  it("refuse to cache a food without a basis", () => {
    expect(() => toCacheRow("k", { ...grilledChickenFood, basis_per_100g: null }, NOW)).toThrow();
  });
});

describe("createSupabaseNutritionCache", () => {
  function fakeClient(result: { data?: unknown; error?: { message: string } | null }) {
    const calls: Array<[string, ...unknown[]]> = [];
    const chain = {
      select: (...args: unknown[]) => (calls.push(["select", ...args]), chain),
      eq: (...args: unknown[]) => (calls.push(["eq", ...args]), chain),
      maybeSingle: async () => ({ data: result.data ?? null, error: result.error ?? null }),
      upsert: async (...args: unknown[]) => (calls.push(["upsert", ...args]), { error: result.error ?? null }),
    };
    const client = { from: (table: string) => (calls.push(["from", table]), chain) } as unknown as SupabaseClient;
    return { client, calls };
  }

  it("reads by query key and source", async () => {
    const { client, calls } = fakeClient({ data: toCacheRow("k", grilledChickenFood, NOW) });
    const cache = createSupabaseNutritionCache({ reader: client, writer: null, now: () => NOW });
    expect(await cache.get("k")).toEqual(grilledChickenFood);
    expect(calls).toContainEqual(["from", "nutrition_cache"]);
    expect(calls).toContainEqual(["eq", "query_key", "k"]);
    expect(calls).toContainEqual(["eq", "source", "usda"]);
  });

  it("writes with the writer client only, as an upsert on (query_key, source)", async () => {
    const reader = fakeClient({});
    const writer = fakeClient({});
    const cache = createSupabaseNutritionCache({ reader: reader.client, writer: writer.client, now: () => NOW });
    await cache.set("k", grilledChickenFood);
    expect(reader.calls).toEqual([]);
    expect(writer.calls).toContainEqual(["upsert", toCacheRow("k", grilledChickenFood, NOW), { onConflict: "query_key,source" }]);
  });

  it("is read-only without a writer", async () => {
    const { client, calls } = fakeClient({});
    await createSupabaseNutritionCache({ reader: client, writer: null }).set("k", grilledChickenFood);
    expect(calls).toEqual([]);
  });

  it("throws on database errors (match.ts treats them as a miss)", async () => {
    const { client } = fakeClient({ error: { message: "permission denied" } });
    const cache = createSupabaseNutritionCache({ reader: client, writer: client });
    await expect(cache.get("k")).rejects.toThrow("permission denied");
    await expect(cache.set("k", grilledChickenFood)).rejects.toThrow("permission denied");
  });
});

describe("matchFood with a cache", () => {
  it("is unchanged without one", async () => {
    const { lookup } = fixtureLookup(SEARCHES);
    const result = await matchFood(grilledChicken, lookup);
    expect(result.status).toBe("matched");
  });

  it("searches USDA on a miss and stores the match", async () => {
    const { lookup, requests } = fixtureLookup(SEARCHES);
    const { cache, store } = memoryCache();
    const result = await matchFood(grilledChicken, lookup, cache);

    expect(result.status).toBe("matched");
    expect(requests.length).toBeGreaterThan(0);
    const stored = store.get(nutritionCacheKey(grilledChicken));
    expect(stored?.fdcId).toBe(result.status === "matched" ? Number(result.item.source_reference) : -1);
  });

  it("skips USDA on a hit and produces the same item", async () => {
    const first = fixtureLookup(SEARCHES);
    const { cache } = memoryCache();
    const miss = await matchFood(grilledChicken, first.lookup, cache);

    const second = fixtureLookup(SEARCHES);
    const hit = await matchFood(grilledChicken, second.lookup, cache);
    expect(second.requests).toEqual([]);
    expect(hit).toEqual(miss);
    expect(cache.set).toHaveBeenCalledTimes(1);
  });

  it("keeps portions fetched on a miss, so a hit needs no detail call", async () => {
    // "1 breast" isn't in the unit table, so the first lookup fetches USDA portions.
    const breast = { ...grilledChicken, quantity: 1, unit: "breast" };
    const { cache, store } = memoryCache();
    const first = fixtureLookup(SEARCHES);
    await matchFood(breast, first.lookup, cache);
    expect(first.requests.some((r) => r.method === "GET")).toBe(true);
    expect(store.get(nutritionCacheKey(breast))?.portions.length).toBeGreaterThan(0);

    const second = fixtureLookup(SEARCHES);
    await matchFood(breast, second.lookup, cache);
    expect(second.requests).toEqual([]);
  });

  it("ignores a cached food the matcher would reject", async () => {
    const { lookup, requests } = fixtureLookup(SEARCHES);
    const wrong: UsdaFood = { ...grilledChickenFood, fdcId: 1, description: "Soup, chicken noodle, canned" };
    const { cache } = memoryCache({ [nutritionCacheKey(grilledChicken)]: wrong });
    const result = await matchFood(grilledChicken, lookup, cache);

    expect(requests.length).toBeGreaterThan(0);
    expect(result.status === "matched" && result.item.source_reference).not.toBe("1");
    expect(cache.set).toHaveBeenCalledTimes(1); // replaced with the real match
  });

  it("still matches when the cache fails", async () => {
    const { lookup } = fixtureLookup(SEARCHES);
    const broken: NutritionCache = {
      get: async () => Promise.reject(new Error("db down")),
      set: async () => Promise.reject(new Error("db down")),
    };
    expect((await matchFood(grilledChicken, lookup, broken)).status).toBe("matched");
  });

  it("caches nothing when there's no match", async () => {
    const { lookup } = fixtureLookup({});
    const { cache } = memoryCache();
    expect((await matchFood(grilledChicken, lookup, cache)).status).toBe("unmatched");
    expect(cache.set).not.toHaveBeenCalled();
  });
});
