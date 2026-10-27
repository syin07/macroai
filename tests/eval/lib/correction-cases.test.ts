import { formatInTimeZone } from "date-fns-tz";
import { describe, expect, it } from "vitest";
import { resolveConsumedAt } from "@/lib/ai/dates";
import { loadCorrectionCases, type CorrectionCase } from "./cases";

// correction-cases.jsonl is data for the B10 chat runner (which needs B8's tools). Until then, check
// that every case is well-formed and its expectation refers to things that exist in its own fixture.
const cases = await loadCorrectionCases();

const REQUIRED_INPUTS = [
  "remove the cheese",
  "I only ate half",
  "that was lunch yesterday",
  "make it 2 eggs not 3",
  "it was 200g not 150g",
  "actually that was skim milk",
  "delete that last meal",
];

function itemIds(c: CorrectionCase, mealId: string): string[] {
  return c.recent_meals.find((m) => m.id === mealId)?.items.map((i) => i.id) ?? [];
}

describe("correction-cases.jsonl", () => {
  it("has the 8 required phrasings, including one that needs a clarification", () => {
    expect(cases.length).toBeGreaterThanOrEqual(8);
    const inputs = cases.map((c) => c.input);
    for (const input of REQUIRED_INPUTS) expect(inputs).toContain(input);
    expect(cases.some((c) => c.expected.kind === "clarification")).toBe(true);
    expect(cases.some((c) => c.expected.kind === "delete")).toBe(true);
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s: fixture is consistent", (_, c) => {
    const now = new Date(c.now).getTime();
    const mealIds = c.recent_meals.map((m) => m.id);
    expect(new Set(mealIds).size, "meal ids unique").toBe(mealIds.length);

    // Newest first, never in the future.
    const times = c.recent_meals.map((m) => new Date(m.consumed_at).getTime());
    for (const [i, t] of times.entries()) {
      expect(t, `${mealIds[i]} not in the future`).toBeLessThanOrEqual(now);
      if (i > 0) expect(t, "recent_meals newest first").toBeLessThanOrEqual(times[i - 1]!);
    }

    const { expected } = c;
    if (expected.kind === "clarification") {
      for (const id of expected.candidate_meal_ids) expect(mealIds).toContain(id);
      return;
    }

    expect(mealIds).toContain(expected.meal_id);
    if (expected.kind === "delete") return;

    const meal = c.recent_meals.find((m) => m.id === expected.meal_id)!;
    expect(expected.version, "the tool must send the version it read (PRD 12.14)").toBe(meal.version);

    const ids = itemIds(c, expected.meal_id);
    const referenced = [
      ...(expected.removed_items ?? []),
      ...Object.keys(expected.item_grams ?? {}),
      ...Object.keys(expected.item_quantity ?? {}),
      ...Object.keys(expected.item_renamed ?? {}),
    ];
    for (const id of referenced) expect(ids, `item ${id} is in ${meal.id}`).toContain(id);

    const changes = [
      expected.removed_items?.length,
      expected.scale_all,
      Object.keys(expected.item_grams ?? {}).length,
      Object.keys(expected.item_quantity ?? {}).length,
      Object.keys(expected.item_renamed ?? {}).length,
      expected.consumed_local_date,
    ].filter(Boolean);
    expect(changes.length, "an update expects at least one change").toBeGreaterThan(0);

    if (expected.consumed_local_hours) {
      const [from, to] = expected.consumed_local_hours;
      expect(from).toBeLessThan(to);
      expect(expected.consumed_local_date, "hours need a date").toBeDefined();
    }
  });

  it("date moves agree with the date resolver", () => {
    const moves = cases.filter((c) => c.expected.kind === "update" && c.expected.time_phrase);
    expect(moves.length).toBeGreaterThan(0);
    for (const c of moves) {
      if (c.expected.kind !== "update") continue;
      const resolved = resolveConsumedAt({
        timePhrase: c.expected.time_phrase!,
        modelConsumedAt: null,
        now: new Date(c.now),
        timezone: c.timezone,
      });
      const instant = new Date(resolved);
      expect(formatInTimeZone(instant, c.timezone, "yyyy-MM-dd"), c.id).toBe(c.expected.consumed_local_date);
      if (c.expected.consumed_local_hours) {
        const hour = Number(formatInTimeZone(instant, c.timezone, "H"));
        const [from, to] = c.expected.consumed_local_hours;
        expect(hour, c.id).toBeGreaterThanOrEqual(from);
        expect(hour, c.id).toBeLessThan(to);
      }
    }
  });
});
