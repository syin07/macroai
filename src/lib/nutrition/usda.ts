import { z } from "zod";
import type { Macros } from "@/types/api";

// USDA FoodData Central client, normalized to per-100 g macros.
// Server-only: the API key is sent in a header (never the URL) so it can't leak into logs.

export type UsdaDataType = "Foundation" | "SR Legacy" | "Survey (FNDDS)" | "Branded";

// Generic (unbranded) foods. Foundation and SR Legacy are preferred by the matcher; FNDDS covers mixed dishes.
export const GENERIC_DATA_TYPES: UsdaDataType[] = ["Foundation", "SR Legacy", "Survey (FNDDS)"];
export const BRANDED_DATA_TYPES: UsdaDataType[] = ["Branded"];

export interface FoodPortion {
  amount: number;       // e.g. 1
  unit: string;         // raw USDA wording, e.g. "cup, chopped", "large", "slice"
  gramWeight: number;   // grams for `amount` of `unit`
}

export interface ServingSize {
  amount: number;
  unit: "g" | "ml";
  household: string | null;  // label wording, e.g. "1 bottle"
}

export interface UsdaFood {
  fdcId: number;
  description: string;
  dataType: string;
  brand: string | null;
  basis_per_100g: Macros | null;  // null when energy or a macro is missing; such foods can't be used
  portions: FoodPortion[];        // only filled by getFood(); search results have none
  serving: ServingSize | null;    // Branded foods only
}

export interface SearchOptions {
  dataTypes?: UsdaDataType[];
  pageSize?: number;
}

export interface NutritionLookup {
  searchFoods(query: string, options?: SearchOptions): Promise<UsdaFood[]>;
  getFood(fdcId: number): Promise<UsdaFood | null>;
}

export class UsdaError extends Error {
  constructor(
    readonly kind: "http" | "rate_limited" | "timeout" | "invalid_response",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "UsdaError";
  }
}

// FDC nutrient IDs.
export const NUTRIENT = {
  energyKcal: 1008,
  energyAtwaterSpecific: 2048,
  energyAtwaterGeneral: 2047,
  protein: 1003,
  fat: 1004,
  carbsByDifference: 1005,
  carbsBySummation: 1050,
} as const;

// Foundation foods often report only Atwater energy; 1008 wins when present, then the more precise specific factors.
const ENERGY_PREFERENCE = [NUTRIENT.energyKcal, NUTRIENT.energyAtwaterSpecific, NUTRIENT.energyAtwaterGeneral];
const CARBS_PREFERENCE = [NUTRIENT.carbsByDifference, NUTRIENT.carbsBySummation];

// --- Response schemas (only the fields we use; everything else is stripped) ---

const searchNutrientSchema = z.object({
  nutrientId: z.number().optional(),
  unitName: z.string().optional(),
  value: z.number().optional(),
});

const brandedFields = {
  brandOwner: z.string().nullish(),
  brandName: z.string().nullish(),
  servingSize: z.number().nullish(),
  servingSizeUnit: z.string().nullish(),
  householdServingFullText: z.string().nullish(),
};

const searchResponseSchema = z.object({
  foods: z
    .array(
      z.object({
        fdcId: z.number().int(),
        description: z.string(),
        dataType: z.string(),
        ...brandedFields,
        foodNutrients: z.array(searchNutrientSchema).default([]),
      }),
    )
    .default([]),
});

const detailNutrientSchema = z.object({
  nutrient: z.object({ id: z.number(), unitName: z.string().optional() }).optional(),
  amount: z.number().optional(),
});

const portionSchema = z.object({
  amount: z.number().nullish(),
  gramWeight: z.number().nullish(),
  modifier: z.string().nullish(),
  portionDescription: z.string().nullish(),
  measureUnit: z.object({ name: z.string().nullish() }).nullish(),
  sequenceNumber: z.number().nullish(),
});

const detailResponseSchema = z.object({
  fdcId: z.number().int(),
  description: z.string(),
  dataType: z.string(),
  ...brandedFields,
  foodNutrients: z.array(detailNutrientSchema).default([]),
  foodPortions: z.array(portionSchema).default([]),
});

// --- Normalization ---

type NutrientValue = { id: number; unit: string | undefined; value: number };

function pick(values: NutrientValue[], ids: readonly number[], unit?: string): number | null {
  for (const id of ids) {
    const found = values.find(
      (v) => v.id === id && (unit === undefined || v.unit === undefined || v.unit.toLowerCase() === unit),
    );
    if (found) return found.value;
  }
  return null;
}

export function toBasis(values: NutrientValue[]): Macros | null {
  const calories = pick(values, ENERGY_PREFERENCE, "kcal");
  const protein_g = pick(values, [NUTRIENT.protein]);
  const carbs_g = pick(values, CARBS_PREFERENCE);
  const fat_g = pick(values, [NUTRIENT.fat]);
  if (calories === null || protein_g === null || carbs_g === null || fat_g === null) return null;
  // USDA occasionally reports tiny negative "by difference" carbs; clamp so the basis passes macrosSchema.
  return {
    calories: Math.max(0, calories),
    protein_g: Math.max(0, protein_g),
    carbs_g: Math.max(0, carbs_g),
    fat_g: Math.max(0, fat_g),
  };
}

type BrandedFields = { dataType: string; servingSize?: number | null; servingSizeUnit?: string | null; householdServingFullText?: string | null };

function toServing(food: BrandedFields): ServingSize | null {
  if (food.dataType !== "Branded" || !food.servingSize || food.servingSize <= 0 || !food.servingSizeUnit) return null;
  const unit = food.servingSizeUnit.toLowerCase();
  const normalized = unit === "g" || unit === "grm" ? "g" : unit === "ml" || unit === "mlt" ? "ml" : null;
  if (!normalized) return null;
  return { amount: food.servingSize, unit: normalized, household: food.householdServingFullText?.trim() || null };
}

// Product line and owner often differ ("CORE POWER" by "Fair Oaks Farms Brands, Inc."); keep both for matching.
function brandOf(food: { brandName?: string | null; brandOwner?: string | null }): string | null {
  const name = food.brandName?.trim();
  const owner = food.brandOwner?.trim();
  if (name && owner && name.toLowerCase() !== owner.toLowerCase()) return `${name} (${owner})`;
  return name || owner || null;
}

const LEADING_AMOUNT = /^\s*(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+))?\s+(.*)$/;

// SR Legacy puts the unit in `modifier` ("cup, chopped") with measureUnit "undetermined";
// Foundation uses measureUnit; FNDDS uses portionDescription ("1 cup"). Accept all three.
export function toPortion(raw: z.infer<typeof portionSchema>): FoodPortion | null {
  const gramWeight = raw.gramWeight ?? 0;
  if (gramWeight <= 0) return null;

  const measure = raw.measureUnit?.name?.trim();
  const modifier = raw.modifier?.trim();
  let amount = raw.amount ?? null;
  let unit: string | null = null;

  if (measure && measure.toLowerCase() !== "undetermined") {
    unit = modifier && !/^\d+$/.test(modifier) ? `${measure}, ${modifier}` : measure;
  } else if (modifier && !/^\d+$/.test(modifier)) {
    unit = modifier;
  } else if (raw.portionDescription) {
    const match = LEADING_AMOUNT.exec(raw.portionDescription);
    if (match) {
      const [, whole, denominator, rest] = match;
      amount ??= denominator ? Number(whole) / Number(denominator) : Number(whole);
      unit = rest?.trim() || null;
    }
  }

  if (!unit || amount === null || amount <= 0) return null;
  return { amount, unit, gramWeight };
}

// --- Client ---

export interface UsdaClientOptions {
  apiKey: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://api.nal.usda.gov/fdc/v1";

export function createUsdaClient(options: UsdaClientOptions): NutritionLookup {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? 8_000;

  async function request(path: string, init?: RequestInit): Promise<unknown | null> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers: { "X-Api-Key": options.apiKey, Accept: "application/json", ...init?.headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new UsdaError("timeout", "USDA request timed out");
      }
      throw new UsdaError("http", "USDA request failed");
    }
    if (response.status === 404) return null;
    if (response.status === 429) throw new UsdaError("rate_limited", "USDA rate limit reached", 429);
    if (!response.ok) throw new UsdaError("http", `USDA request failed with status ${response.status}`, response.status);
    try {
      return await response.json();
    } catch {
      throw new UsdaError("invalid_response", "USDA returned invalid JSON", response.status);
    }
  }

  function parse<T>(schema: z.ZodType<T>, body: unknown): T {
    const result = schema.safeParse(body);
    if (!result.success) throw new UsdaError("invalid_response", "USDA response did not match the expected shape");
    return result.data;
  }

  return {
    async searchFoods(query, { dataTypes = GENERIC_DATA_TYPES, pageSize = 25 } = {}) {
      const body = await request("/foods/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, dataType: dataTypes, pageSize }),
      });
      if (body === null) return [];
      return parse(searchResponseSchema, body).foods.map((food) => ({
        fdcId: food.fdcId,
        description: food.description,
        dataType: food.dataType,
        brand: brandOf(food),
        basis_per_100g: toBasis(
          food.foodNutrients.flatMap((n) =>
            n.nutrientId !== undefined && n.value !== undefined
              ? [{ id: n.nutrientId, unit: n.unitName, value: n.value }]
              : [],
          ),
        ),
        portions: [],
        serving: toServing(food),
      }));
    },

    async getFood(fdcId) {
      if (!Number.isInteger(fdcId) || fdcId <= 0) return null;
      const body = await request(`/food/${fdcId}`);
      if (body === null) return null;
      const food = parse(detailResponseSchema, body);
      const portions = [...food.foodPortions]
        .sort((a, b) => (a.sequenceNumber ?? 0) - (b.sequenceNumber ?? 0))
        .flatMap((p) => toPortion(p) ?? []);
      return {
        fdcId: food.fdcId,
        description: food.description,
        dataType: food.dataType,
        brand: brandOf(food),
        basis_per_100g: toBasis(
          food.foodNutrients.flatMap((n) =>
            n.nutrient && n.amount !== undefined
              ? [{ id: n.nutrient.id, unit: n.nutrient.unitName, value: n.amount }]
              : [],
          ),
        ),
        portions,
        serving: toServing(food),
      };
    },
  };
}

let defaultClient: NutritionLookup | null = null;

function envClient(): NutritionLookup {
  if (defaultClient) return defaultClient;
  const apiKey = process.env.USDA_API_KEY;
  if (!apiKey) throw new UsdaError("http", "USDA_API_KEY is not set");
  defaultClient = createUsdaClient({ apiKey });
  return defaultClient;
}

export function searchFoods(query: string, options?: SearchOptions): Promise<UsdaFood[]> {
  return envClient().searchFoods(query, options);
}

export function getFood(fdcId: number): Promise<UsdaFood | null> {
  return envClient().getFood(fdcId);
}
