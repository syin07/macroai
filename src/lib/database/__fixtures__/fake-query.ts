import type { SupabaseClient } from "@supabase/supabase-js";

// A small in-memory stand-in for the PostgREST query builder: enough of select / eq / neq / in / is /
// order / range / maybeSingle for the export queries. It applies the filters to the rows it holds, so
// tests can check what a query returns, and records every filter so they can check how it asked.
// It does not enforce RLS: tests seed another user's rows to prove the user_id filters are there.

type Row = Record<string, unknown>;

export interface FakeCall {
  table: string;
  op: string;
  args: unknown[];
}

export function createFakeQueryClient(tables: Record<string, Row[]>, options: { failOn?: string } = {}) {
  const calls: FakeCall[] = [];

  function from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let range: [number, number] | null = null;
    const record = (op: string, ...args: unknown[]) => calls.push({ table, op, args });

    const result = () => {
      if (options.failOn === table) return { data: null, error: { message: "boom" } };
      let rows = (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
      if (range) rows = rows.slice(range[0], range[1] + 1);
      return { data: rows, error: null };
    };

    const chain = {
      select: (...args: unknown[]) => (record("select", ...args), chain),
      eq: (column: string, value: unknown) => {
        record("eq", column, value);
        filters.push((row) => row[column] === value);
        return chain;
      },
      neq: (column: string, value: unknown) => {
        record("neq", column, value);
        filters.push((row) => row[column] !== value);
        return chain;
      },
      in: (column: string, values: unknown[]) => {
        record("in", column, values);
        filters.push((row) => values.includes(row[column]));
        return chain;
      },
      is: (column: string, value: unknown) => {
        record("is", column, value);
        filters.push((row) => (row[column] ?? null) === value);
        return chain;
      },
      order: (...args: unknown[]) => (record("order", ...args), chain),
      range: (from: number, to: number) => {
        record("range", from, to);
        range = [from, to];
        return chain;
      },
      overrideTypes: () => chain,
      maybeSingle: async () => {
        const { data, error } = result();
        return { data: data?.[0] ?? null, error };
      },
      then: <T>(resolve: (value: ReturnType<typeof result>) => T, reject?: (reason: unknown) => T) =>
        Promise.resolve(result()).then(resolve, reject),
    };
    return chain;
  }

  return { client: { from } as unknown as SupabaseClient, calls };
}
