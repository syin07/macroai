import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { macrosSchema } from "@/lib/validation/meal";
import type { ExtractedFood } from "./match";
import { words } from "./text";
import type { UsdaFood } from "./usda";

// nutrition_cache: one resolved USDA food per normalized query, so repeat foods skip the search and
// detail calls (PRD Step C, "check the nutrition lookup cache first"). Shared reference data: any
// approved user can read it, only the service role can write it (supabase/migrations/0001_init.sql).
//
// match.ts re-scores a cached food against the current extraction before using it, so the cache can
// never produce a match the matcher itself would reject.

export interface NutritionCache {
  get(key: string): Promise<UsdaFood | null>;
  set(key: string, food: UsdaFood): Promise<void>;
}

// Bump when the matcher's choices change enough that old entries should be ignored.
const KEY_VERSION = "usda-match-v1";
const DEFAULT_TTL_DAYS = 180;

function normalize(text: string | null | undefined): string {
  return text ? words(text).join(" ") : "";
}

// Every field the matcher reads goes into the key: brand changes the search plan, and name and
// preparation decide raw vs cooked. Punctuation, case, and plurals don't matter.
export function nutritionCacheKey(food: ExtractedFood): string {
  return [KEY_VERSION, food.brand, food.search_query, food.preparation, food.name].map(normalize).join("|");
}

// Everything in UsdaFood besides the basis lives in the `portions` jsonb column.
const portionsColumnSchema = z.object({
  description: z.string(),
  data_type: z.string(),
  brand: z.string().nullable(),
  portions: z.array(z.object({ amount: z.number().positive(), unit: z.string(), gramWeight: z.number().positive() })),
  serving: z
    .object({ amount: z.number().positive(), unit: z.enum(["g", "ml"]), household: z.string().nullable() })
    .nullable(),
});

const rowSchema = z.object({
  source_reference: z.string().regex(/^\d+$/),
  per_100g: macrosSchema,
  portions: portionsColumnSchema,
  fetched_at: z.string(),
});

export function toCacheRow(key: string, food: UsdaFood, now: Date) {
  if (!food.basis_per_100g) throw new Error("Only foods with a basis can be cached");
  return {
    query_key: key,
    source: "usda" as const,
    source_reference: String(food.fdcId),
    per_100g: food.basis_per_100g,
    portions: {
      description: food.description,
      data_type: food.dataType,
      brand: food.brand,
      portions: food.portions,
      serving: food.serving,
    } satisfies z.infer<typeof portionsColumnSchema>,
    fetched_at: now.toISOString(),
  };
}

// A malformed or expired row is a miss, not an error.
export function fromCacheRow(row: unknown, now: Date, ttlDays = DEFAULT_TTL_DAYS): UsdaFood | null {
  const parsed = rowSchema.safeParse(row);
  if (!parsed.success) return null;
  const { source_reference, per_100g, portions, fetched_at } = parsed.data;
  const age = now.getTime() - Date.parse(fetched_at);
  if (!(age <= ttlDays * 24 * 60 * 60 * 1000)) return null;
  return {
    fdcId: Number(source_reference),
    description: portions.description,
    dataType: portions.data_type,
    brand: portions.brand,
    basis_per_100g: per_100g,
    portions: portions.portions,
    serving: portions.serving,
  };
}

export interface SupabaseNutritionCacheOptions {
  reader: SupabaseClient;         // the user's client; RLS allows approved users to read
  writer: SupabaseClient | null;  // service-role client; null makes the cache read-only
  ttlDays?: number;
  now?: () => Date;
}

// Errors are thrown; match.ts treats a failing cache as a miss so lookups never depend on it.
export function createSupabaseNutritionCache(options: SupabaseNutritionCacheOptions): NutritionCache {
  const now = options.now ?? (() => new Date());
  return {
    async get(key) {
      const { data, error } = await options.reader
        .from("nutrition_cache")
        .select("source_reference, per_100g, portions, fetched_at")
        .eq("query_key", key)
        .eq("source", "usda")
        .maybeSingle();
      if (error) throw new Error(`nutrition_cache read failed: ${error.message}`);
      return data ? fromCacheRow(data, now(), options.ttlDays) : null;
    },
    async set(key, food) {
      if (!options.writer || !food.basis_per_100g) return;
      const { error } = await options.writer
        .from("nutrition_cache")
        .upsert(toCacheRow(key, food, now()), { onConflict: "query_key,source" });
      if (error) throw new Error(`nutrition_cache write failed: ${error.message}`);
    },
  };
}
