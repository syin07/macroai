import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Confidence,
  ExportScope,
  Macros,
  Meal,
  MealCard,
  MealItem,
  MealSourceType,
  Memory,
  NutritionSource,
  Preferences,
} from "@/types/api";

// Data for GET /api/export (PRD FR-18). Every query runs on the user's own client from requireUser(),
// so RLS limits results to their rows; the explicit user_id filters are a second guard, not the only
// one. Never pass the service-role client here.
//
// Meals in pending_deletion are left out: they already stopped counting and are about to be purged.

export const EXPORT_FORMAT_VERSION = 1;

// PostgREST caps a response at max_rows (1000 in supabase/config.toml); page well under it.
const PAGE_SIZE = 500;

export interface ExportUser {
  id: string;
  email: string | null;
}

export interface ExportMessage {
  id: string;
  conversation_id: string;
  client_message_id: string | null;
  role: "user" | "assistant";
  text: string;
  cards: MealCard[];
  had_image: boolean;
  status: "sent" | "pending" | "error";
  related_meal_id: string | null;
  created_at: string;
}

export interface ExportGoals extends Macros {
  effective_from: string;
  effective_to: string | null;
}

export interface ExportAccount {
  user_id: string;
  email: string | null;
  display_name: string | null;
  preferences: Preferences | null;
  goals: ExportGoals[];
}

export interface NutritionExport {
  format_version: typeof EXPORT_FORMAT_VERSION;
  scope: "nutrition";
  exported_at: string;
  timezone: string;
  meals: Meal[];
}

export interface AccountExport extends Omit<NutritionExport, "scope"> {
  scope: "account";
  account: ExportAccount;
  messages: ExportMessage[];
  memories: Memory[];
}

export type ExportData = NutritionExport | AccountExport;

// --- Row shapes (as PostgREST returns them; numeric columns arrive as numbers or strings) ---

type Numeric = number | string;

interface MealItemRow {
  id: string;
  position: number;
  food_name: string;
  quantity: Numeric;
  unit: string;
  grams: Numeric | null;
  basis_per_100g: Record<keyof Macros, Numeric> | null;
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

interface MealRow {
  id: string;
  name: string;
  consumed_at: string;
  created_at: string;
  updated_at: string;
  source_type: MealSourceType;
  total_calories: Numeric;
  total_protein_g: Numeric;
  total_carbs_g: Numeric;
  total_fat_g: Numeric;
  status: Meal["status"];
  version: number;
  meal_items: MealItemRow[] | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  client_message_id: string | null;
  role: ExportMessage["role"];
  content: string;
  cards: MealCard[] | null;
  had_image: boolean;
  status: ExportMessage["status"];
  related_meal_id: string | null;
  created_at: string;
}

interface GoalsRow {
  calorie_target: Numeric;
  protein_target_g: Numeric;
  carbs_target_g: Numeric;
  fat_target_g: Numeric;
  effective_from: string;
  effective_to: string | null;
}

const MEAL_COLUMNS = [
  "id, name, consumed_at, created_at, updated_at, source_type",
  "total_calories, total_protein_g, total_carbs_g, total_fat_g, status, version",
  "meal_items(id, position, food_name, quantity, unit, grams, basis_per_100g, calories, protein_g, carbs_g, " +
    "fat_g, nutrition_source, source_reference, inferred, confidence, edited_by_user, assumptions)",
].join(", ");

const MESSAGE_COLUMNS =
  "id, conversation_id, client_message_id, role, content, cards, had_image, status, related_meal_id, created_at";

// --- Mapping ---

const num = (value: Numeric) => Number(value);
const numOrNull = (value: Numeric | null) => (value === null ? null : Number(value));

function toMacros(row: Record<keyof Macros, Numeric>): Macros {
  return { calories: num(row.calories), protein_g: num(row.protein_g), carbs_g: num(row.carbs_g), fat_g: num(row.fat_g) };
}

function toMealItem(row: MealItemRow): MealItem {
  return {
    id: row.id,
    food_name: row.food_name,
    quantity: num(row.quantity),
    unit: row.unit,
    grams: numOrNull(row.grams),
    basis_per_100g: row.basis_per_100g ? toMacros(row.basis_per_100g) : null,
    macros: toMacros(row),
    nutrition_source: row.nutrition_source,
    source_reference: row.source_reference,
    inferred: row.inferred,
    confidence: row.confidence,
    edited_by_user: row.edited_by_user,
    assumptions: row.assumptions,
  };
}

export function toExportMeal(row: MealRow): Meal {
  const items = [...(row.meal_items ?? [])].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  return {
    id: row.id,
    name: row.name,
    consumed_at: row.consumed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source_type: row.source_type,
    items: items.map(toMealItem),
    totals: {
      calories: num(row.total_calories),
      protein_g: num(row.total_protein_g),
      carbs_g: num(row.total_carbs_g),
      fat_g: num(row.total_fat_g),
    },
    status: row.status,
    version: row.version,
  };
}

function toExportMessage(row: MessageRow): ExportMessage {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    client_message_id: row.client_message_id,
    role: row.role,
    text: row.content,
    cards: row.cards ?? [],
    had_image: row.had_image,
    status: row.status,
    related_meal_id: row.related_meal_id,
    created_at: row.created_at,
  };
}

function toExportGoals(row: GoalsRow): ExportGoals {
  return {
    calories: num(row.calorie_target),
    protein_g: num(row.protein_target_g),
    carbs_g: num(row.carbs_target_g),
    fat_g: num(row.fat_target_g),
    effective_from: row.effective_from,
    effective_to: row.effective_to,
  };
}

// --- Queries ---

type PageResult<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

async function fetchAll<T>(what: string, page: (from: number, to: number) => PageResult<T>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${what} select failed: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

export async function loadExportMeals(supabase: SupabaseClient, userId: string): Promise<Meal[]> {
  const rows = await fetchAll<MealRow>("meals", (from, to) =>
    supabase
      .from("meals")
      .select(MEAL_COLUMNS)
      .eq("user_id", userId)
      .eq("status", "active")
      .order("consumed_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to)
      .overrideTypes<MealRow[], { merge: false }>(),
  );
  return rows.map(toExportMeal);
}

// Chat history as the user saw it: tool rows are internal plumbing and deleted messages are gone.
export async function loadExportMessages(supabase: SupabaseClient, userId: string): Promise<ExportMessage[]> {
  const rows = await fetchAll<MessageRow>("messages", (from, to) =>
    supabase
      .from("messages")
      .select(MESSAGE_COLUMNS)
      .eq("user_id", userId)
      .in("role", ["user", "assistant"])
      .neq("status", "deleted")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to)
      .overrideTypes<MessageRow[], { merge: false }>(),
  );
  return rows.map(toExportMessage);
}

export async function loadExportMemories(supabase: SupabaseClient, userId: string): Promise<Memory[]> {
  const rows = await fetchAll<Memory>("user_memories", (from, to) =>
    supabase
      .from("user_memories")
      .select("id, category, content, created_at, updated_at")
      .eq("user_id", userId)
      .is("deleted_at", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to)
      .overrideTypes<Memory[], { merge: false }>(),
  );
  return rows.map(({ id, category, content, created_at, updated_at }) => ({ id, category, content, created_at, updated_at }));
}

interface ProfileRow {
  display_name: string | null;
  timezone: string;
}

export async function loadExportProfile(supabase: SupabaseClient, userId: string): Promise<ProfileRow> {
  const { data, error } = await supabase
    .from("profiles")
    .select("display_name, timezone")
    .eq("id", userId)
    .maybeSingle<ProfileRow>();
  if (error) throw new Error(`profiles select failed: ${error.message}`);
  return { display_name: data?.display_name ?? null, timezone: data?.timezone ?? "UTC" };
}

async function loadExportAccount(
  supabase: SupabaseClient,
  user: ExportUser,
  profile: ProfileRow,
): Promise<ExportAccount> {
  const [prefs, goals] = await Promise.all([
    supabase
      .from("account_preferences")
      .select("theme, save_mode, assistant_style")
      .eq("user_id", user.id)
      .maybeSingle<Omit<Preferences, "timezone">>(),
    fetchAll<GoalsRow>("nutrition_goals", (from, to) =>
      supabase
        .from("nutrition_goals")
        .select("calorie_target, protein_target_g, carbs_target_g, fat_target_g, effective_from, effective_to")
        .eq("user_id", user.id)
        .order("effective_from", { ascending: true })
        .range(from, to)
        .overrideTypes<GoalsRow[], { merge: false }>(),
    ),
  ]);
  if (prefs.error) throw new Error(`account_preferences select failed: ${prefs.error.message}`);
  return {
    user_id: user.id,
    email: user.email,
    display_name: profile.display_name,
    preferences: prefs.data
      ? {
          theme: prefs.data.theme,
          save_mode: prefs.data.save_mode,
          timezone: profile.timezone,
          assistant_style: prefs.data.assistant_style,
        }
      : null,
    goals: goals.map(toExportGoals),
  };
}

// Everything one export needs. `user` must come from requireUser(), `supabase` is that user's client.
export async function loadExport(
  supabase: SupabaseClient,
  user: ExportUser,
  scope: ExportScope,
  now: Date = new Date(),
): Promise<ExportData> {
  const profile = await loadExportProfile(supabase, user.id);
  const base = {
    format_version: EXPORT_FORMAT_VERSION,
    exported_at: now.toISOString(),
    timezone: profile.timezone,
  } as const;

  if (scope === "nutrition") {
    return { ...base, scope, meals: await loadExportMeals(supabase, user.id) };
  }

  const [meals, messages, memories, account] = await Promise.all([
    loadExportMeals(supabase, user.id),
    loadExportMessages(supabase, user.id),
    loadExportMemories(supabase, user.id),
    loadExportAccount(supabase, user, profile),
  ]);
  return { ...base, scope, account, meals, messages, memories };
}
