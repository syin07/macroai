import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { matchFood } from "@/lib/nutrition/match";
import { createUsdaClient, type NutritionLookup as UsdaClient, type UsdaFood as ClientFood } from "@/lib/nutrition/usda";
import type { Macros } from "@/types/api";

// The seam between the bake-off and nutrition matching. MatcherLookup (bottom) uses B5's matcher, the
// same ranking and rejection rules production will use. UsdaApiLookup is the earlier stand-in (top
// search hit, no ranking); compute-truth.ts still uses it for getFood by exact FDC ID, where ranking
// doesn't matter.

export interface FoodBasis {
  fdcId: number;
  description: string;
  dataType: string;
  basisPer100g: Macros;
}

export interface FoodQuery {
  searchQuery: string;
  name: string;
  preparation: string | null;
  brand: string | null;
}

export interface NutritionLookup {
  // Best database match for an extracted food, or null if nothing is good enough.
  search(query: FoodQuery): Promise<FoodBasis | null>;
  // Exact food by USDA FDC ID (used for ground truth).
  getFood(fdcId: number): Promise<FoodBasis | null>;
}

// --- USDA FoodData Central nutrient normalization ---------------------------------------------------

// Energy is reported under 1008 (SR Legacy, Branded) or the Atwater factors 2048 / 2047 (Foundation).
const ENERGY_IDS = [1008, 2048, 2047];
const PROTEIN_ID = 1003;
const FAT_ID = 1004;
const CARBS_ID = 1005;

interface SearchFoodNutrient {
  nutrientId?: number;
  unitName?: string;
  value?: number;
}

interface DetailFoodNutrient {
  nutrient?: { id?: number; unitName?: string };
  amount?: number;
}

export interface UsdaFood {
  fdcId: number;
  description: string;
  dataType?: string;
  foodNutrients?: Array<SearchFoodNutrient & DetailFoodNutrient>;
}

// Search results and /food/{id} details use different nutrient shapes; read either.
function nutrientAmounts(food: UsdaFood): Map<number, { unit: string; amount: number }> {
  const amounts = new Map<number, { unit: string; amount: number }>();
  for (const entry of food.foodNutrients ?? []) {
    const id = entry.nutrientId ?? entry.nutrient?.id;
    const amount = entry.value ?? entry.amount;
    const unit = (entry.unitName ?? entry.nutrient?.unitName ?? "").toUpperCase();
    if (id !== undefined && typeof amount === "number" && Number.isFinite(amount)) {
      amounts.set(id, { unit, amount });
    }
  }
  return amounts;
}

// Per-100 g basis for Foundation / SR Legacy / Branded foods (all report nutrients per 100 g).
// Returns null when there's no kcal energy value, so a food without energy is never used.
export function basisFromUsdaFood(food: UsdaFood): FoodBasis | null {
  const amounts = nutrientAmounts(food);
  const energy = ENERGY_IDS.map((id) => amounts.get(id)).find((entry) => entry?.unit === "KCAL");
  if (!energy) return null;
  const grams = (id: number) => amounts.get(id)?.amount ?? 0;
  return {
    fdcId: food.fdcId,
    description: food.description,
    dataType: food.dataType ?? "unknown",
    basisPer100g: {
      calories: energy.amount,
      protein_g: grams(PROTEIN_ID),
      carbs_g: grams(CARBS_ID),
      fat_g: grams(FAT_ID),
    },
  };
}

// --- Stand-in: USDA FDC API, top hit, cached on disk ------------------------------------------------

const FDC_BASE_URL = "https://api.nal.usda.gov/fdc/v1";
const GENERIC_DATA_TYPES = ["Foundation", "SR Legacy"];

type Fetch = typeof fetch;

export interface UsdaApiLookupOptions {
  apiKey?: string;   // defaults to USDA_API_KEY, then DEMO_KEY (very low rate limit)
  cacheFile?: string; // JSON file of raw responses, so reruns don't spend the 1,000/hour quota
  fetchImpl?: Fetch;
}

export class UsdaApiLookup implements NutritionLookup {
  private readonly apiKey: string;
  private readonly cacheFile: string | undefined;
  private readonly fetchImpl: Fetch;
  private cache: Record<string, unknown> | undefined;

  constructor(options: UsdaApiLookupOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.USDA_API_KEY ?? "DEMO_KEY";
    this.cacheFile = options.cacheFile;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async search(query: FoodQuery): Promise<FoodBasis | null> {
    const dataType = query.brand ? ["Branded"] : GENERIC_DATA_TYPES;
    const text = query.brand ? `${query.brand} ${query.searchQuery}` : query.searchQuery;
    const body = await this.cached(`search:${dataType.join("+")}:${text.toLowerCase()}`, () =>
      this.request("/foods/search", { method: "POST", body: JSON.stringify({ query: text, dataType, pageSize: 5 }) }),
    );
    const foods = (body as { foods?: UsdaFood[] }).foods ?? [];
    for (const food of foods) {
      const basis = basisFromUsdaFood(food);
      if (basis) return basis;
    }
    return null;
  }

  async getFood(fdcId: number): Promise<FoodBasis | null> {
    const body = await this.cached(`food:${fdcId}`, () => this.request(`/food/${fdcId}`, { method: "GET" }));
    return body ? basisFromUsdaFood(body as UsdaFood) : null;
  }

  private async request(pathname: string, init: RequestInit): Promise<unknown> {
    const response = await this.fetchImpl(`${FDC_BASE_URL}${pathname}`, {
      ...init,
      headers: { "Content-Type": "application/json", "X-Api-Key": this.apiKey },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`USDA ${pathname} failed: HTTP ${response.status}`);
    return response.json();
  }

  private async cached(key: string, load: () => Promise<unknown>): Promise<unknown> {
    const cache = await this.loadCache();
    if (key in cache) return cache[key];
    const value = await load();
    cache[key] = value;
    if (this.cacheFile) {
      await mkdir(path.dirname(this.cacheFile), { recursive: true });
      await writeFile(this.cacheFile, JSON.stringify(cache));
    }
    return value;
  }

  private async loadCache(): Promise<Record<string, unknown>> {
    if (this.cache) return this.cache;
    this.cache = {};
    if (this.cacheFile) {
      try {
        this.cache = JSON.parse(await readFile(this.cacheFile, "utf8")) as Record<string, unknown>;
      } catch {
        // No cache yet.
      }
    }
    return this.cache;
  }
}

// --- B5 matcher (src/lib/nutrition/match.ts) --------------------------------------------------------

// Asks the matcher for a 100 g portion so it returns the per-100 g basis; the pipeline then scales by the
// model's own gram estimate, which is what the bake-off compares across models.
export class MatcherLookup implements NutritionLookup {
  constructor(private readonly client: UsdaClient) {}

  async search(query: FoodQuery): Promise<FoodBasis | null> {
    const result = await matchFood(
      {
        name: query.name,
        quantity: 100,
        unit: "g",
        preparation: query.preparation,
        inferred: false,
        confidence: "medium",
        search_query: query.searchQuery,
        brand: query.brand,
      },
      this.client,
    );
    if (result.status === "unmatched" && result.reason === "lookup_failed") {
      console.warn(`  USDA lookup failed for "${query.searchQuery}"; using the model's estimate`);
    }
    const basis = result.status === "matched" ? result.item.basis_per_100g : null;
    if (result.status !== "matched" || !basis) return null;
    return {
      fdcId: result.match.food.fdcId,
      description: result.match.food.description,
      dataType: result.match.food.dataType,
      basisPer100g: basis,
    };
  }

  async getFood(fdcId: number): Promise<FoodBasis | null> {
    const food = await this.client.getFood(fdcId);
    return food?.basis_per_100g
      ? { fdcId: food.fdcId, description: food.description, dataType: food.dataType, basisPer100g: food.basis_per_100g }
      : null;
  }
}

// B5's USDA client with responses cached on disk, so reruns don't spend the 1,000/hour quota.
export function cachedUsdaClient(options: { apiKey: string; cacheFile: string; fetchImpl?: Fetch }): UsdaClient {
  const client = createUsdaClient({ apiKey: options.apiKey, fetch: options.fetchImpl });
  let cache: Record<string, unknown> | undefined;

  async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (!cache) {
      try {
        cache = JSON.parse(await readFile(options.cacheFile, "utf8")) as Record<string, unknown>;
      } catch {
        cache = {};
      }
    }
    if (key in cache) return cache[key] as T;
    const value = await load();
    cache[key] = value;
    await mkdir(path.dirname(options.cacheFile), { recursive: true });
    await writeFile(options.cacheFile, JSON.stringify(cache));
    return value;
  }

  return {
    searchFoods: (query, searchOptions) =>
      cached(`search:${(searchOptions?.dataTypes ?? []).join("+")}:${searchOptions?.pageSize ?? ""}:${query.toLowerCase()}`, () =>
        client.searchFoods(query, searchOptions),
      ),
    getFood: (fdcId) => cached<ClientFood | null>(`food:${fdcId}`, () => client.getFood(fdcId)),
  };
}
