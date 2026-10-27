import { vi } from "vitest";

// A small in-memory stand-in for the PostgREST query builder (`supabase.from(table)...`), enough for
// route tests to run real filters against seeded rows instead of asserting on call chains. Supports
// select (with { count: "exact", head }) / insert / update / upsert / delete, filters eq, neq, gt, gte, lt,
// lte, is, or ("col.op.value,..."), order, limit, range, single, maybeSingle. Unique keys are enforced per table, so a write that Postgres would
// reject fails here too. Values compare as strings or numbers; ISO dates compare correctly as strings.

type Row = Record<string, unknown>;
type Op = "select" | "insert" | "update" | "upsert" | "delete";

export interface MemoryDbOptions {
  // Seed rows per table. The arrays are copied.
  tables?: Record<string, Row[]>;
  // Unique keys per table, e.g. { nutrition_goals: [["user_id", "effective_from"]] }.
  unique?: Record<string, string[][]>;
  // Row checks per table; return a message to reject the write like a CHECK constraint.
  checks?: Record<string, (row: Row) => string | null>;
  // Make every `op` on `table` fail with a database error.
  fail?: { table: string; op: Op };
  // Column defaults per table, applied on insert like Postgres `default` (e.g. timestamps).
  defaults?: Record<string, () => Row>;
}

interface Filter {
  test: (row: Row) => boolean;
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function parseValue(raw: string): unknown {
  if (raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw;
}

function opFilter(column: string, op: string, value: unknown): Filter {
  return {
    test: (row) => {
      const cell = row[column];
      switch (op) {
        case "eq":
          return cell !== null && cell !== undefined && String(cell) === String(value);
        case "neq":
          return cell !== null && cell !== undefined && String(cell) !== String(value);
        case "is":
          return value === null ? cell === null || cell === undefined : cell === value;
        case "gt":
          return cell !== null && cell !== undefined && compare(cell, value) > 0;
        case "gte":
          return cell !== null && cell !== undefined && compare(cell, value) >= 0;
        case "lt":
          return cell !== null && cell !== undefined && compare(cell, value) < 0;
        case "lte":
          return cell !== null && cell !== undefined && compare(cell, value) <= 0;
        default:
          throw new Error(`memory-supabase: unsupported operator ${op}`);
      }
    },
  };
}

function project(row: Row, columns: string): Row {
  if (columns.trim() === "*") return { ...row };
  const out: Row = {};
  for (const column of columns.split(",").map((c) => c.trim()).filter(Boolean)) out[column] = row[column] ?? null;
  return out;
}

export function createMemoryDb(options: MemoryDbOptions = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(options.tables ?? {})) tables[name] = rows.map((row) => ({ ...row }));
  let nextId = 1;

  function violation(table: string, rows: Row[]): string | null {
    for (const key of options.unique?.[table] ?? []) {
      const seen = new Set<string>();
      for (const row of rows) {
        const value = JSON.stringify(key.map((column) => row[column]));
        if (seen.has(value)) return `duplicate key value violates unique constraint (${key.join(", ")})`;
        seen.add(value);
      }
    }
    const check = options.checks?.[table];
    for (const row of check ? rows : []) {
      const message = check!(row);
      if (message) return message;
    }
    return null;
  }

  function from(table: string) {
    tables[table] ??= [];
    let op: Op = "select";
    let payload: Row | Row[] | null = null;
    let onConflict: string[] = [];
    let returning: string | null = null;
    let single: "single" | "maybe" | null = null;
    const filters: Filter[] = [];
    let orderBy: { column: string; ascending: boolean } | null = null;
    let limit: number | null = null;
    let offset = 0;
    let count: "exact" | null = null;
    let head = false;

    function matching(): Row[] {
      let rows = tables[table].filter((row) => filters.every((f) => f.test(row)));
      if (orderBy) {
        const { column, ascending } = orderBy;
        rows = [...rows].sort((a, b) => (ascending ? 1 : -1) * compare(a[column], b[column]));
      }
      return limit === null ? rows.slice(offset) : rows.slice(offset, offset + limit);
    }

    function write(): { rows: Row[]; error: string | null } {
      const current = tables[table];
      let next: Row[];
      let affected: Row[];
      if (op === "insert" || op === "upsert") {
        const incoming = (Array.isArray(payload) ? payload : [payload!]).map(
          (row): Row => ({ id: `row-${nextId++}`, ...options.defaults?.[table]?.(), ...row }),
        );
        next = current.map((row) => ({ ...row }));
        affected = [];
        for (const row of incoming) {
          const existing =
            op === "upsert" && onConflict.length > 0
              ? next.find((candidate) => onConflict.every((column) => String(candidate[column]) === String(row[column])))
              : undefined;
          if (existing) {
            const changes = { ...row };
            delete changes.id; // the existing row keeps its id
            Object.assign(existing, changes);
            affected.push(existing);
          } else {
            next.push(row);
            affected.push(row);
          }
        }
      } else if (op === "update") {
        const targets = new Set(matching());
        next = current.map((row) => (targets.has(row) ? { ...row, ...(payload as Row) } : { ...row }));
        affected = next.filter((_, i) => targets.has(current[i]));
      } else {
        const targets = new Set(matching());
        next = current.filter((row) => !targets.has(row));
        affected = current.filter((row) => targets.has(row));
      }
      const error = violation(table, next);
      if (error) return { rows: [], error };
      tables[table] = next;
      return { rows: affected, error: null };
    }

    function execute(): { data: unknown; error: { message: string } | null; count?: number | null } {
      if (options.fail?.table === table && options.fail.op === op) return { data: null, error: { message: "boom" } };
      let rows: Row[];
      if (op === "select") {
        rows = matching();
        if (count !== null) return { data: head ? null : rows.map((row) => project(row, returning ?? "*")), error: null, count: rows.length };
      } else {
        const result = write();
        if (result.error) return { data: null, error: { message: result.error } };
        rows = result.rows;
      }
      const columns = op === "select" ? (returning ?? "*") : returning;
      const projected = columns === null ? null : rows.map((row) => project(row, columns));
      if (single === null) return { data: projected, error: null };
      const list = projected ?? [];
      if (list.length > 1) return { data: null, error: { message: "multiple rows returned" } };
      if (list.length === 0 && single === "single") return { data: null, error: { message: "no rows returned" } };
      return { data: list[0] ?? null, error: null };
    }

    const builder = {
      select: vi.fn((columns = "*", opts: { count?: "exact"; head?: boolean } = {}) => {
        returning = columns;
        count = opts.count ?? null;
        head = opts.head ?? false;
        return builder;
      }),
      insert: vi.fn((values: Row | Row[]) => {
        op = "insert";
        payload = values;
        return builder;
      }),
      upsert: vi.fn((values: Row | Row[], opts: { onConflict?: string } = {}) => {
        op = "upsert";
        payload = values;
        onConflict = (opts.onConflict ?? "").split(",").map((c) => c.trim()).filter(Boolean);
        return builder;
      }),
      update: vi.fn((values: Row) => {
        op = "update";
        payload = values;
        return builder;
      }),
      delete: vi.fn(() => {
        op = "delete";
        return builder;
      }),
      eq: vi.fn((column: string, value: unknown) => (filters.push(opFilter(column, "eq", value)), builder)),
      neq: vi.fn((column: string, value: unknown) => (filters.push(opFilter(column, "neq", value)), builder)),
      gt: vi.fn((column: string, value: unknown) => (filters.push(opFilter(column, "gt", value)), builder)),
      gte: vi.fn((column: string, value: unknown) => (filters.push(opFilter(column, "gte", value)), builder)),
      lt: vi.fn((column: string, value: unknown) => (filters.push(opFilter(column, "lt", value)), builder)),
      lte: vi.fn((column: string, value: unknown) => (filters.push(opFilter(column, "lte", value)), builder)),
      is: vi.fn((column: string, value: unknown) => (filters.push(opFilter(column, "is", value)), builder)),
      or: vi.fn((expression: string) => {
        const parts = expression.split(",").map((part) => {
          const [column, operator, ...rest] = part.split(".");
          return opFilter(column, operator, parseValue(rest.join(".")));
        });
        filters.push({ test: (row) => parts.some((p) => p.test(row)) });
        return builder;
      }),
      order: vi.fn((column: string, opts: { ascending?: boolean } = {}) => {
        orderBy = { column, ascending: opts.ascending ?? true };
        return builder;
      }),
      limit: vi.fn((n: number) => ((limit = n), builder)),
      range: vi.fn((from: number, to: number) => ((offset = from), (limit = to - from + 1), builder)),
      overrideTypes: vi.fn(() => builder),
      single: vi.fn(async () => ((single = "single"), execute())),
      maybeSingle: vi.fn(async () => ((single = "maybe"), execute())),
      then<T1, T2 = never>(
        resolve: (value: ReturnType<typeof execute>) => T1 | PromiseLike<T1>,
        reject?: (reason: unknown) => T2 | PromiseLike<T2>,
      ) {
        return Promise.resolve().then(execute).then(resolve, reject);
      },
    };
    return builder;
  }

  return {
    from: vi.fn(from),
    // Current rows of a table (a copy), for assertions.
    rows: (table: string): Row[] => (tables[table] ?? []).map((row) => ({ ...row })),
  };
}

export type MemoryDb = ReturnType<typeof createMemoryDb>;

const MEMORY_CATEGORIES = [
  "frequent_food",
  "portion",
  "brand",
  "dietary",
  "preparation",
  "correction",
  "response_style",
  "assumption",
];

function memoryCheck(row: Row): string | null {
  if (!MEMORY_CATEGORIES.includes(String(row.category))) return "new row violates check constraint (category)";
  if (typeof row.content !== "string" || row.content.length === 0) return "null value in column \"content\"";
  return null;
}

// The MacroAI tables' keys, checks, and defaults from supabase/migrations/ that the routes rely on.
export function createAppDb(tables: Record<string, Row[]> = {}, fail?: MemoryDbOptions["fail"]) {
  const now = () => new Date().toISOString();
  return createMemoryDb({
    tables,
    fail,
    defaults: {
      user_memories: () => ({
        id: crypto.randomUUID(),
        source_message_id: null,
        created_at: now(),
        updated_at: now(),
        deleted_at: null,
      }),
      memory_candidates: () => ({ id: crypto.randomUUID(), occurrences: 1, created_at: now(), last_seen_at: now() }),
      ai_usage: () => ({ created_at: now() }),
    },
    unique: {
      profiles: [["id"]],
      account_preferences: [["user_id"]],
      nutrition_goals: [["user_id", "effective_from"]],
    },
    checks: {
      nutrition_goals: (row) =>
        row.effective_to !== null && row.effective_to !== undefined && String(row.effective_to) <= String(row.effective_from)
          ? "new row violates check constraint (effective_to > effective_from)"
          : null,
      user_memories: memoryCheck,
      memory_candidates: (row) =>
        memoryCheck(row) ?? (Number(row.occurrences) >= 1 ? null : "new row violates check constraint (occurrences)"),
    },
  });
}
