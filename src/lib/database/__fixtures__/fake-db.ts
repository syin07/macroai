import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MealItemRow, MealRow } from "../meals";

// An in-memory stand-in for the slice of Supabase the meals routes use: the PostgREST query builder
// calls in src/lib/database/{meals,daily}.ts and the SQL functions in 0002_meals_api.sql, re-implemented
// in JS with the same semantics. RLS is emulated: a user client only sees its own rows; the service-role
// client sees everything. numeric(10,3) storage is emulated by rounding stored numbers to 3 decimals.
// The SQL functions themselves are tested for real in supabase/tests/meals_api.test.sql.

const UNDO_WINDOW_MS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;

type StoredMeal = Omit<MealRow, "meal_items">;
type StoredItem = MealItemRow & { meal_id: string };

export interface FakeDb {
  profiles: Array<{ id: string; timezone: string }>;
  meals: StoredMeal[];
  meal_items: StoredItem[];
  meal_revisions: Array<{
    id: string;
    meal_id: string;
    user_id: string;
    previous_values: unknown;
    updated_values: unknown;
    reason: "created" | "updated" | "deleted" | "restored";
    created_at: string;
  }>;
  idempotency_keys: Array<{ user_id: string; key: string; response: unknown; created_at: string }>;
  nutrition_goals: Array<{
    user_id: string;
    calorie_target: number;
    protein_target_g: number;
    carbs_target_g: number;
    fat_target_g: number;
    effective_from: string;
    effective_to: string | null;
  }>;
  temporary_uploads: Array<{ id: string; user_id: string; expires_at: string }>;
  // Test hooks
  failRpc?: string; // the next call of this function fails with a Postgres error
  beforeRpc?: (name: string) => void;
}

export function createFakeDb(): FakeDb {
  return {
    profiles: [],
    meals: [],
    meal_items: [],
    meal_revisions: [],
    idempotency_keys: [],
    nutrition_goals: [],
    temporary_uploads: [],
  };
}

type Auth = { userId: string } | "service_role";
type Row = Record<string, unknown>;
type Result<T> = { data: T; error: null } | { data: null; error: { code: string; message: string } };

const nowIso = () => new Date(Date.now()).toISOString();
const n3 = (value: unknown) => (value === null || value === undefined ? null : Math.round(Number(value) * 1000) / 1000);
const pgError = (code: string, message: string) => ({ data: null, error: { code, message } });

// Compare values the way Postgres would for the columns we filter on (timestamps, dates, text, numbers).
function compare(a: unknown, b: unknown): number {
  if (typeof a === "string" && typeof b === "string") {
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    if (/^\d{4}-\d{2}-\d{2}T/.test(a) && /^\d{4}-\d{2}-\d{2}T/.test(b) && !Number.isNaN(ta) && !Number.isNaN(tb)) {
      return ta - tb;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return Number(a) - Number(b);
}

class FakeQuery<T = unknown> implements PromiseLike<Result<T>> {
  private filters: Array<(row: Row) => boolean> = [];
  private orders: Array<{ column: string; ascending: boolean }> = [];
  private max: number | null = null;
  private embedItems = false;

  constructor(
    private readonly db: FakeDb,
    private readonly table: keyof FakeDb,
    private readonly auth: Auth,
  ) {}

  select(columns = "*") {
    this.embedItems = columns.includes("meal_items(");
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  in(column: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  gte(column: string, value: unknown) {
    this.filters.push((row) => compare(row[column], value) >= 0);
    return this;
  }
  lt(column: string, value: unknown) {
    this.filters.push((row) => compare(row[column], value) < 0);
    return this;
  }
  lte(column: string, value: unknown) {
    this.filters.push((row) => compare(row[column], value) <= 0);
    return this;
  }
  // PostgREST or filter, flat form only: "col.op.value,col.op.value" with op in is/eq/gt/gte/lt/lte.
  or(expression: string) {
    const tests = expression.split(",").map((part) => {
      const [column, op, ...rest] = part.split(".");
      const raw = rest.join(".");
      const value = raw === "null" ? null : raw;
      return (row: Row) => {
        const cell = row[column!];
        if (op === "is" || value === null) return cell === value;
        if (cell === null || cell === undefined) return false;
        const c = compare(cell, value);
        return op === "eq" ? c === 0 : op === "gt" ? c > 0 : op === "gte" ? c >= 0 : op === "lt" ? c < 0 : op === "lte" ? c <= 0 : false;
      };
    });
    this.filters.push((row) => tests.some((test) => test(row)));
    return this;
  }
  order(column: string, options: { ascending?: boolean } = {}) {
    this.orders.push({ column, ascending: options.ascending ?? true });
    return this;
  }
  limit(count: number) {
    this.max = count;
    return this;
  }
  returns<U>() {
    return this as unknown as FakeQuery<U>;
  }

  private visible(row: Row): boolean {
    if (this.auth === "service_role") return true;
    const uid = this.auth.userId;
    switch (this.table) {
      case "profiles":
        return row.id === uid;
      case "meal_items":
        return this.db.meals.some((meal) => meal.id === row.meal_id && meal.user_id === uid);
      default:
        return row.user_id === uid;
    }
  }

  private run(): Row[] {
    let rows = (this.db[this.table] as Row[]).filter((row) => this.visible(row) && this.filters.every((f) => f(row)));
    for (const { column, ascending } of [...this.orders].reverse()) {
      rows = [...rows].sort((a, b) => (ascending ? 1 : -1) * compare(a[column], b[column]));
    }
    if (this.max !== null) rows = rows.slice(0, this.max);
    return rows.map((row) => {
      const copy = structuredClone(row);
      if (this.embedItems) {
        copy.meal_items = structuredClone(this.db.meal_items.filter((item) => item.meal_id === row.id));
      }
      return copy;
    });
  }

  async maybeSingle<U = T>(): Promise<Result<U | null>> {
    const rows = this.run();
    if (rows.length > 1) return pgError("PGRST116", "multiple rows");
    return { data: (rows[0] ?? null) as U | null, error: null };
  }

  then<R1 = Result<T>, R2 = never>(
    onfulfilled?: ((value: Result<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve({ data: this.run() as T, error: null } as Result<T>).then(onfulfilled, onrejected);
  }
}

// ---------------------------------------------------------------------------
// SQL functions (see 0002_meals_api.sql)
// ---------------------------------------------------------------------------

interface ItemJson {
  id?: string | null;
  food_name: string;
  quantity: number;
  unit: string;
  grams: number | null;
  basis_per_100g: ItemJson["macros"] | null;
  macros: { calories: number; protein_g: number; carbs_g: number; fat_g: number };
  nutrition_source: MealItemRow["nutrition_source"];
  source_reference: string | null;
  inferred: boolean;
  confidence: MealItemRow["confidence"];
  edited_by_user: boolean;
  assumptions: string | null;
}

function storedItem(mealId: string, position: number, item: ItemJson, id: string = randomUUID()): StoredItem {
  return {
    id,
    meal_id: mealId,
    position,
    food_name: item.food_name,
    quantity: n3(item.quantity)!,
    unit: item.unit,
    grams: n3(item.grams),
    basis_per_100g: item.basis_per_100g,
    calories: n3(item.macros.calories)!,
    protein_g: n3(item.macros.protein_g)!,
    carbs_g: n3(item.macros.carbs_g)!,
    fat_g: n3(item.macros.fat_g)!,
    nutrition_source: item.nutrition_source,
    source_reference: item.source_reference,
    inferred: item.inferred,
    confidence: item.confidence,
    edited_by_user: item.edited_by_user,
    assumptions: item.assumptions,
  };
}

function snapshot(db: FakeDb, mealId: string) {
  const meal = db.meals.find((m) => m.id === mealId)!;
  return structuredClone({ ...meal, items: db.meal_items.filter((item) => item.meal_id === mealId) });
}

function revise(db: FakeDb, mealId: string, userId: string, reason: FakeDb["meal_revisions"][number]["reason"], previous: unknown, updated: unknown) {
  db.meal_revisions.push({ id: randomUUID(), meal_id: mealId, user_id: userId, previous_values: previous, updated_values: updated, reason, created_at: nowIso() });
}

function setTotals(meal: StoredMeal, totals: { calories: number; protein_g: number; carbs_g: number; fat_g: number }) {
  meal.total_calories = n3(totals.calories)!;
  meal.total_protein_g = n3(totals.protein_g)!;
  meal.total_carbs_g = n3(totals.carbs_g)!;
  meal.total_fat_g = n3(totals.fat_g)!;
}

type Args = Record<string, unknown>;

function callRpc(db: FakeDb, auth: Auth, name: string, args: Args): Result<unknown> {
  if (name === "purge_expired") {
    if (auth !== "service_role") return pgError("42501", "permission denied for function purge_expired");
    const now = Date.now();
    const expired = new Set(
      db.meals.filter((m) => m.status === "pending_deletion" && Date.parse(m.deleted_at!) + UNDO_WINDOW_MS <= now).map((m) => m.id),
    );
    db.meals = db.meals.filter((m) => !expired.has(m.id));
    db.meal_items = db.meal_items.filter((item) => !expired.has(item.meal_id));
    db.meal_revisions = db.meal_revisions.filter((rev) => !expired.has(rev.meal_id));
    const keysBefore = db.idempotency_keys.length;
    db.idempotency_keys = db.idempotency_keys.filter((k) => Date.parse(k.created_at) >= now - DAY_MS);
    const uploadsBefore = db.temporary_uploads.length;
    db.temporary_uploads = db.temporary_uploads.filter((u) => Date.parse(u.expires_at) >= now);
    return {
      data: { meals: expired.size, idempotency_keys: keysBefore - db.idempotency_keys.length, temporary_uploads: uploadsBefore - db.temporary_uploads.length },
      error: null,
    };
  }

  if (auth === "service_role") return pgError("42501", "not authenticated");
  const uid = auth.userId;
  const own = (id: unknown) => db.meals.find((m) => m.id === id && m.user_id === uid);

  switch (name) {
    case "save_meals": {
      const key = String(args.p_idempotency_key);
      const existing = db.idempotency_keys.find((k) => k.user_id === uid && k.key === key);
      if (existing) return { data: { replayed: true, response: structuredClone(existing.response) }, error: null };
      const ids: string[] = [];
      for (const meal of args.p_meals as Array<{ name: string; consumed_at: string; source_type: MealRow["source_type"]; totals: ItemJson["macros"]; items: ItemJson[] }>) {
        const id = randomUUID();
        const stored: StoredMeal = {
          id,
          user_id: uid,
          name: meal.name,
          consumed_at: new Date(meal.consumed_at).toISOString(),
          created_at: nowIso(),
          updated_at: nowIso(),
          source_type: meal.source_type,
          total_calories: 0,
          total_protein_g: 0,
          total_carbs_g: 0,
          total_fat_g: 0,
          status: "active",
          deleted_at: null,
          version: 1,
        };
        setTotals(stored, meal.totals);
        db.meals.push(stored);
        meal.items.forEach((item, position) => db.meal_items.push(storedItem(id, position, item)));
        revise(db, id, uid, "created", null, snapshot(db, id));
        ids.push(id);
      }
      const response = { meal_ids: ids };
      db.idempotency_keys.push({ user_id: uid, key, response, created_at: nowIso() });
      return { data: { replayed: false, response: structuredClone(response) }, error: null };
    }

    case "update_meal": {
      const meal = own(args.p_meal_id);
      if (!meal || meal.status !== "active") return { data: { status: "not_found" }, error: null };
      if (meal.version !== args.p_version) return { data: { status: "version_conflict", version: meal.version }, error: null };
      const items = args.p_items as ItemJson[] | null;
      if (items) {
        const keep = items.flatMap((item) => (item.id ? [item.id] : []));
        const onMeal = new Set(db.meal_items.filter((item) => item.meal_id === meal.id).map((item) => item.id));
        if (new Set(keep).size !== keep.length || keep.some((id) => !onMeal.has(id))) {
          return { data: { status: "invalid_item" }, error: null };
        }
      }
      const previous = snapshot(db, meal.id);
      if (args.p_name !== null) meal.name = String(args.p_name);
      if (args.p_consumed_at !== null) meal.consumed_at = new Date(String(args.p_consumed_at)).toISOString();
      if (items) {
        setTotals(meal, args.p_totals as ItemJson["macros"]);
        db.meal_items = db.meal_items.filter((item) => item.meal_id !== meal.id);
        items.forEach((item, position) => db.meal_items.push(storedItem(meal.id, position, item, item.id ?? randomUUID())));
      }
      meal.version += 1;
      meal.updated_at = nowIso();
      revise(db, meal.id, uid, "updated", previous, snapshot(db, meal.id));
      return { data: { status: "ok", version: meal.version }, error: null };
    }

    case "delete_meal": {
      const meal = own(args.p_meal_id);
      if (!meal || meal.status !== "active") return { data: { status: "not_found" }, error: null };
      meal.status = "pending_deletion";
      meal.deleted_at = nowIso();
      meal.version += 1;
      revise(db, meal.id, uid, "deleted", { status: "active" }, { status: "pending_deletion" });
      return {
        data: { status: "ok", undo_until: new Date(Date.parse(meal.deleted_at) + UNDO_WINDOW_MS).toISOString(), consumed_at: meal.consumed_at },
        error: null,
      };
    }

    case "restore_meal": {
      const meal = own(args.p_meal_id);
      if (!meal || meal.status !== "pending_deletion" || Date.parse(meal.deleted_at!) + UNDO_WINDOW_MS <= Date.now()) {
        return { data: { status: "not_found" }, error: null };
      }
      meal.status = "active";
      meal.deleted_at = null;
      meal.version += 1;
      revise(db, meal.id, uid, "restored", { status: "pending_deletion" }, { status: "active" });
      return { data: { status: "ok", version: meal.version }, error: null };
    }

    case "list_meals": {
      const q = typeof args.p_q === "string" ? args.p_q.toLowerCase() : null;
      const rows = db.meals
        .filter((m) => m.user_id === uid && m.status === "active")
        .filter((m) => args.p_from === null || compare(m.consumed_at, args.p_from) >= 0)
        .filter((m) => args.p_to === null || compare(m.consumed_at, args.p_to) < 0)
        .filter((m) => {
          if (args.p_cursor_consumed_at === null) return true;
          const c = compare(m.consumed_at, args.p_cursor_consumed_at);
          return c < 0 || (c === 0 && m.id < String(args.p_cursor_id));
        })
        .filter(
          (m) =>
            q === null ||
            m.name.toLowerCase().includes(q) ||
            db.meal_items.some((item) => item.meal_id === m.id && item.food_name.toLowerCase().includes(q)),
        )
        .sort((a, b) => compare(b.consumed_at, a.consumed_at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
        .slice(0, Number(args.p_limit));
      return { data: structuredClone(rows), error: null };
    }

    default:
      return pgError("PGRST202", `Could not find the function public.${name}`);
  }
}

export function fakeClient(db: FakeDb, auth: Auth): SupabaseClient {
  const client = {
    from: (table: keyof FakeDb) => new FakeQuery(db, table, auth),
    rpc: async (name: string, args: Args = {}) => {
      db.beforeRpc?.(name);
      if (db.failRpc === name) {
        db.failRpc = undefined;
        return pgError("XX000", `internal failure while saving "${JSON.stringify(args).slice(0, 200)}"`);
      }
      return callRpc(db, auth, name, args);
    },
  };
  return client as unknown as SupabaseClient;
}
