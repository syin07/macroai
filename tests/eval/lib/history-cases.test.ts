import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createFakeDb, fakeClient } from "@/lib/database/__fixtures__/fake-db";
import { seedMeals } from "@/lib/database/__fixtures__/history-seed";
import { findLastMealMatching, searchMealHistory } from "@/lib/database/history";
import { isoDate, isoDateTime, timezone } from "@/lib/validation/common";

// B11 history eval cases (tests/eval/history-cases.jsonl), run against the data layer with no model:
// each case seeds its fixture meals into the in-memory Supabase, makes the call the
// `search_meal_history` tool would make (dates already resolved), and checks the answer numbers.
// Format: tests/eval/README.md, "History cases".

const HISTORY_CASES_FILE = new URL("../history-cases.jsonl", import.meta.url);
const USER = "11111111-1111-4111-8111-111111111111";
const TOLERANCE = 0.001; // expected averages may be written to 3 decimals

const macros = z.strictObject({ calories: z.number(), protein_g: z.number(), carbs_g: z.number(), fat_g: z.number() });

const historyCaseSchema = z.strictObject({
  id: z.string().regex(/^h\d{2}-[a-z0-9-]+$/),
  question: z.string().min(1),
  now: isoDateTime,
  timezone,
  meals: z.array(
    z.strictObject({
      name: z.string().min(1),
      consumed_at: isoDateTime,
      totals: macros,
      items: z.array(z.string().min(1)).optional(),
      status: z.enum(["active", "pending_deletion"]).optional(),
    }),
  ),
  call: z.discriminatedUnion("fn", [
    z.strictObject({
      fn: z.literal("searchMealHistory"),
      args: z.strictObject({
        from: isoDate.optional(),
        to: isoDate.optional(),
        q: z.string().optional(),
        limit: z.number().int().optional(),
        aggregate: z.boolean().optional(),
      }),
    }),
    z.strictObject({
      fn: z.literal("findLastMealMatching"),
      args: z.strictObject({ q: z.string().min(1), before: isoDate.optional() }),
    }),
  ]),
  expect: z.strictObject({
    meal_names: z.array(z.string()).optional(), // newest first
    to: isoDate.optional(), // the range end after clamping to today
    days_in_range: z.number().int().optional(),
    days_with_records: z.number().int().optional(),
    missing_dates: z.array(isoDate).optional(),
    includes_today: z.boolean().optional(),
    sum: macros.partial().optional(),
    average_per_recorded_day: macros.partial().nullable().optional(),
    last_match: z
      .strictObject({
        meal_name: z.string(),
        local_date: isoDate,
        days_ago: z.number().int(),
        matched_items: z.array(z.string()),
        totals: macros.partial().optional(),
      })
      .nullable()
      .optional(),
  }),
  notes: z.string().optional(),
});

type HistoryCase = z.infer<typeof historyCaseSchema>;

async function loadHistoryCases(): Promise<HistoryCase[]> {
  const lines = (await readFile(HISTORY_CASES_FILE, "utf8")).split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line, index) => {
    const parsed = historyCaseSchema.safeParse(JSON.parse(line));
    if (!parsed.success) throw new Error(`history-cases.jsonl line ${index + 1}: ${z.prettifyError(parsed.error)}`);
    return parsed.data;
  });
}

function expectMacrosClose(actual: Record<string, number> | null | undefined, expected: Record<string, number | undefined>) {
  expect(actual).toBeTruthy();
  for (const [key, value] of Object.entries(expected)) {
    if (value === undefined) continue;
    expect(Math.abs(actual![key]! - value), `${key}: got ${actual![key]}, expected ${value}`).toBeLessThanOrEqual(TOLERANCE);
  }
}

const cases = await loadHistoryCases();

describe("history-cases.jsonl", () => {
  it("has unique ids and covers the B11 questions, including a missing day", () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const topic of ["last-tuesday", "protein-yesterday", "last-salmon", "avg-calories-this-week"]) {
      expect(cases.some((c) => c.id.endsWith(topic)), topic).toBe(true);
    }
    expect(cases.some((c) => (c.expect.missing_dates?.length ?? 0) > 0)).toBe(true);
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s", async (_id, testCase) => {
    const db = createFakeDb();
    db.profiles.push({ id: USER, timezone: testCase.timezone });
    seedMeals(db, USER, testCase.meals);
    const supabase = fakeClient(db, { userId: USER });
    const now = new Date(testCase.now);
    const expected = testCase.expect;

    if (testCase.call.fn === "findLastMealMatching") {
      const hit = await findLastMealMatching(supabase, USER, testCase.call.args, now);
      if (expected.last_match === null) {
        expect(hit).toBeNull();
        return;
      }
      if (!expected.last_match) return;
      expect(hit).not.toBeNull();
      expect(hit!.meal.name).toBe(expected.last_match.meal_name);
      expect(hit!.local_date).toBe(expected.last_match.local_date);
      expect(hit!.days_ago).toBe(expected.last_match.days_ago);
      expect(hit!.matched_items).toEqual(expected.last_match.matched_items);
      if (expected.last_match.totals) expectMacrosClose({ ...hit!.meal.totals }, expected.last_match.totals);
      return;
    }

    const result = await searchMealHistory(supabase, USER, testCase.call.args, now);
    if (expected.meal_names) expect(result.meals.map((meal) => meal.name)).toEqual(expected.meal_names);
    if (expected.to) expect(result.to).toBe(expected.to);

    const needsAggregate = ["days_in_range", "days_with_records", "missing_dates", "includes_today", "sum", "average_per_recorded_day"].some(
      (key) => key in expected,
    );
    if (!needsAggregate) return;
    const agg = result.aggregate;
    expect(agg, "case expects aggregate numbers; set aggregate: true in call.args").not.toBeNull();
    if (expected.days_in_range !== undefined) expect(agg!.days_in_range).toBe(expected.days_in_range);
    if (expected.days_with_records !== undefined) expect(agg!.days_with_records).toBe(expected.days_with_records);
    if (expected.missing_dates) expect(agg!.missing_dates).toEqual(expected.missing_dates);
    if (expected.includes_today !== undefined) expect(agg!.includes_today).toBe(expected.includes_today);
    if (expected.sum) expectMacrosClose({ ...agg!.sum }, expected.sum);
    if (expected.average_per_recorded_day === null) expect(agg!.average_per_recorded_day).toBeNull();
    else if (expected.average_per_recorded_day) expectMacrosClose({ ...agg!.average_per_recorded_day! }, expected.average_per_recorded_day);
  });
});
