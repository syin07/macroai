import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type {
  Confidence,
  Macros,
  Meal,
  MealItem,
  MealListItem,
  MealSourceType,
  MealsPage,
  NutritionSource,
} from "@/types/api";
import { ApiErrorException } from "@/lib/api-error";
import { isoDateTime, uuid } from "@/lib/validation/common";
import { DatabaseError, dbError } from "./errors";

// Meal reads and writes for the /api/meals routes (and B8's chat tools). Every function takes the
// user's RLS-scoped client from requireUser(); reads also filter on the session user id as a second
// guard. Writes go through the SQL functions in supabase/migrations/0002_meals_api.sql so each one is a
// single transaction. Nutrition math is not done here: callers pass items and totals already
// recalculated with src/lib/nutrition/calc.ts.

// Mirrors private.meal_undo_window() in 0002_meals_api.sql.
export const UNDO_WINDOW_MS = 10_000;

// ---------------------------------------------------------------------------
// Rows → contract shapes
// ---------------------------------------------------------------------------

type Numeric = number | string;

interface MacrosJson {
  calories: Numeric;
  protein_g: Numeric;
  carbs_g: Numeric;
  fat_g: Numeric;
}

export interface MealItemRow {
  id: string;
  position: number;
  food_name: string;
  quantity: Numeric;
  unit: string;
  grams: Numeric | null;
  basis_per_100g: MacrosJson | null;
  calories: Numeric;
  protein_g: Numeric;
  carbs_g: Numeric;
  fat_g: Numeric;
  nutrition_source: NutritionSource;
  source_reference: string | null;
  inferred: boolean;
  confidence: Confidence | null;
  edited_by_user: boolean;
  assumptions: string | null;
}

export interface MealRow {
  id: string;
  user_id: string;
  name: string;
  consumed_at: string;
  created_at: string;
  updated_at: string;
  source_type: MealSourceType;
  total_calories: Numeric;
  total_protein_g: Numeric;
  total_carbs_g: Numeric;
  total_fat_g: Numeric;
  status: "active" | "pending_deletion";
  deleted_at: string | null;
  version: number;
  meal_items?: MealItemRow[];
}

const ITEM_COLUMNS =
  "id, position, food_name, quantity, unit, grams, basis_per_100g, calories, protein_g, carbs_g, fat_g, " +
  "nutrition_source, source_reference, inferred, confidence, edited_by_user, assumptions";
const MEAL_COLUMNS =
  "id, user_id, name, consumed_at, created_at, updated_at, source_type, " +
  "total_calories, total_protein_g, total_carbs_g, total_fat_g, status, deleted_at, version";
const MEAL_WITH_ITEMS = `${MEAL_COLUMNS}, meal_items(${ITEM_COLUMNS})`;

// numeric columns may arrive as strings depending on the client; values are never rounded here.
const num = (value: Numeric): number => Number(value);
const numOrNull = (value: Numeric | null): number | null => (value === null ? null : Number(value));

function macrosFrom(json: MacrosJson): Macros {
  return {
    calories: num(json.calories),
    protein_g: num(json.protein_g),
    carbs_g: num(json.carbs_g),
    fat_g: num(json.fat_g),
  };
}

export function mealTotalsFromRow(row: Pick<MealRow, "total_calories" | "total_protein_g" | "total_carbs_g" | "total_fat_g">): Macros {
  return {
    calories: num(row.total_calories),
    protein_g: num(row.total_protein_g),
    carbs_g: num(row.total_carbs_g),
    fat_g: num(row.total_fat_g),
  };
}

export function toMealItem(row: MealItemRow): MealItem {
  return {
    id: row.id,
    food_name: row.food_name,
    quantity: num(row.quantity),
    unit: row.unit,
    grams: numOrNull(row.grams),
    basis_per_100g: row.basis_per_100g ? macrosFrom(row.basis_per_100g) : null,
    macros: macrosFrom(row),
    nutrition_source: row.nutrition_source,
    source_reference: row.source_reference,
    inferred: row.inferred,
    confidence: row.confidence,
    edited_by_user: row.edited_by_user,
    assumptions: row.assumptions,
  };
}

export function toMeal(row: MealRow): Meal {
  const items = [...(row.meal_items ?? [])].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  return {
    id: row.id,
    name: row.name,
    consumed_at: row.consumed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source_type: row.source_type,
    items: items.map(toMealItem),
    totals: mealTotalsFromRow(row),
    status: row.status,
    version: row.version,
  };
}

export function toMealListItem(row: Pick<MealRow, "id" | "name" | "consumed_at" | "total_calories" | "total_protein_g" | "total_carbs_g" | "total_fat_g">): MealListItem {
  return { id: row.id, name: row.name, consumed_at: row.consumed_at, totals: mealTotalsFromRow(row) };
}

// A pending_deletion meal stays readable (status "pending_deletion") until its undo window ends;
// after that it is gone as far as the API is concerned, even before the purge job removes it.
export function isVisible(row: Pick<MealRow, "status" | "deleted_at">, now: number = Date.now()): boolean {
  if (row.status === "active") return true;
  return row.deleted_at !== null && new Date(row.deleted_at).getTime() + UNDO_WINDOW_MS > now;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// One meal with its items, or null if it doesn't exist, belongs to someone else, or was deleted and its
// undo window has passed.
export async function findMeal(supabase: SupabaseClient, userId: string, mealId: string): Promise<Meal | null> {
  const { data, error } = await supabase
    .from("meals")
    .select(MEAL_WITH_ITEMS)
    .eq("id", mealId)
    .eq("user_id", userId)
    .maybeSingle<MealRow>();
  if (error) throw dbError("meals select", error);
  return data && isVisible(data) ? toMeal(data) : null;
}

// Meals by id, in the order given; missing or no-longer-visible ids are skipped.
export async function findMeals(supabase: SupabaseClient, userId: string, mealIds: readonly string[]): Promise<Meal[]> {
  if (mealIds.length === 0) return [];
  const { data, error } = await supabase
    .from("meals")
    .select(MEAL_WITH_ITEMS)
    .in("id", [...mealIds])
    .eq("user_id", userId)
    .returns<MealRow[]>();
  if (error) throw dbError("meals select", error);
  const byId = new Map((data ?? []).filter((row) => isVisible(row)).map((row) => [row.id, toMeal(row)]));
  return mealIds.flatMap((id) => byId.get(id) ?? []);
}

// Active meals consumed in [start, end), oldest first, for daily summaries.
export async function activeMealsBetween(
  supabase: SupabaseClient,
  userId: string,
  start: string,
  end: string,
): Promise<MealListItem[]> {
  const { data, error } = await supabase
    .from("meals")
    .select("id, name, consumed_at, total_calories, total_protein_g, total_carbs_g, total_fat_g")
    .eq("user_id", userId)
    .eq("status", "active")
    .gte("consumed_at", start)
    .lt("consumed_at", end)
    .order("consumed_at", { ascending: true })
    .order("id", { ascending: true })
    .returns<MealRow[]>();
  if (error) throw dbError("meals select", error);
  return (data ?? []).map(toMealListItem);
}

// --- GET /api/meals cursor: opaque base64url of [consumed_at, id] from the last row of the page. ---

const cursorSchema = z.tuple([isoDateTime, uuid]);

export function encodeCursor(row: Pick<MealRow, "consumed_at" | "id">): string {
  return Buffer.from(JSON.stringify([row.consumed_at, row.id])).toString("base64url");
}

export function decodeCursor(cursor: string): { consumedAt: string; id: string } {
  try {
    const [consumedAt, id] = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return { consumedAt, id };
  } catch {
    throw new ApiErrorException("validation_error", { fields: { cursor: "Invalid cursor" } });
  }
}

export interface ListMealsOptions {
  from: string | null; // inclusive instant
  to: string | null; // exclusive instant
  q: string | null;
  cursor: string | null;
  limit: number;
}

// Newest consumed first. `q` matches meal names and item names.
export async function listMeals(supabase: SupabaseClient, options: ListMealsOptions): Promise<MealsPage> {
  const after = options.cursor ? decodeCursor(options.cursor) : null;
  const { data, error } = await supabase.rpc("list_meals", {
    p_from: options.from,
    p_to: options.to,
    p_q: options.q,
    p_cursor_consumed_at: after?.consumedAt ?? null,
    p_cursor_id: after?.id ?? null,
    p_limit: options.limit + 1, // one extra row tells us whether there is a next page
  });
  if (error) throw dbError("list_meals", error);
  const rows = (data ?? []) as MealRow[];
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    meals: page.map(toMealListItem),
    next_cursor: rows.length > options.limit && last ? encodeCursor(last) : null,
  };
}

// ---------------------------------------------------------------------------
// Writes (SQL functions in 0002_meals_api.sql)
// ---------------------------------------------------------------------------

// A meal ready to store: items and totals already recalculated server-side.
export interface PreparedMeal {
  name: string;
  consumed_at: string;
  source_type: MealSourceType;
  totals: Macros;
  items: Array<Omit<MealItem, "id">>;
}

export interface PreparedItem extends Omit<MealItem, "id"> {
  id: string | null;
}

const saveResultSchema = z.object({
  replayed: z.boolean(),
  response: z.object({ meal_ids: z.array(z.string()) }),
});

// Saves meals atomically under an idempotency key. A repeat of a key returns the first save's meal ids
// with replayed: true, and writes nothing.
export async function saveMeals(
  supabase: SupabaseClient,
  idempotencyKey: string,
  meals: readonly PreparedMeal[],
): Promise<{ replayed: boolean; mealIds: string[] }> {
  const { data, error } = await supabase.rpc("save_meals", { p_idempotency_key: idempotencyKey, p_meals: meals });
  if (error) throw dbError("save_meals", error);
  const result = saveResultSchema.safeParse(data);
  if (!result.success) throw new DatabaseError("save_meals", "unexpected_result");
  return { replayed: result.data.replayed, mealIds: result.data.response.meal_ids };
}

export type UpdateMealResult =
  | { status: "ok"; version: number }
  | { status: "not_found" }
  | { status: "version_conflict"; version: number }
  | { status: "invalid_item" };

export interface MealChanges {
  version: number;
  name?: string;
  consumed_at?: string;
  items?: PreparedItem[];
  totals?: Macros; // required with items
}

export async function updateMeal(supabase: SupabaseClient, mealId: string, changes: MealChanges): Promise<UpdateMealResult> {
  const { data, error } = await supabase.rpc("update_meal", {
    p_meal_id: mealId,
    p_version: changes.version,
    p_name: changes.name ?? null,
    p_consumed_at: changes.consumed_at ?? null,
    p_items: changes.items ?? null,
    p_totals: changes.items ? (changes.totals ?? null) : null,
  });
  if (error) throw dbError("update_meal", error);
  return data as UpdateMealResult;
}

export type DeleteMealResult = { status: "ok"; undo_until: string; consumed_at: string } | { status: "not_found" };

export async function deleteMeal(supabase: SupabaseClient, mealId: string): Promise<DeleteMealResult> {
  const { data, error } = await supabase.rpc("delete_meal", { p_meal_id: mealId });
  if (error) throw dbError("delete_meal", error);
  return data as DeleteMealResult;
}

export async function restoreMeal(supabase: SupabaseClient, mealId: string): Promise<{ status: "ok" | "not_found" }> {
  const { data, error } = await supabase.rpc("restore_meal", { p_meal_id: mealId });
  if (error) throw dbError("restore_meal", error);
  return data as { status: "ok" | "not_found" };
}

export interface PurgeCounts {
  meals: number;
  idempotency_keys: number;
  temporary_uploads: number;
}

// Service-role client only (the cron route).
export async function purgeExpired(admin: SupabaseClient): Promise<PurgeCounts> {
  const { data, error } = await admin.rpc("purge_expired");
  if (error) throw dbError("purge_expired", error);
  return data as PurgeCounts;
}
