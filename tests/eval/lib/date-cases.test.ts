import { formatInTimeZone } from "date-fns-tz";
import { describe, expect, it } from "vitest";
import { resolveConsumedAt } from "@/lib/ai/dates";
import { datePhraseSchema, loadDateCases, parseDateCases } from "./cases";

// date-cases.jsonl runs through the production date resolver in code, with no model involved, so it
// runs in CI. The model's only job for dates is copying the user's words into time_phrase.
const cases = await loadDateCases();

describe("date-cases.jsonl", () => {
  it("covers each of the six PRD FR-09 phrasings at least 3 times", () => {
    for (const phrase of datePhraseSchema.options) {
      expect(cases.filter((c) => c.phrase === phrase).length, phrase).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s", (_, c) => {
    const now = new Date(c.now);
    const resolved = resolveConsumedAt({ timePhrase: c.input, modelConsumedAt: null, now, timezone: c.timezone });
    const instant = new Date(resolved);
    expect(formatInTimeZone(instant, c.timezone, "yyyy-MM-dd'T'HH:mm"), c.note ?? c.input).toBe(c.expected_local);
    expect(instant.getTime()).toBeLessThanOrEqual(now.getTime());
  });

  it("rejects malformed cases", () => {
    const line = (expected_local: string) =>
      JSON.stringify({
        id: "x",
        phrase: "yesterday",
        input: "yesterday",
        now: "2026-10-26T12:30:00-07:00",
        timezone: "America/Los_Angeles",
        expected_local,
      });
    expect(() => parseDateCases(line("2026-10-25 12:30"))).toThrow(/line 1/);
    expect(() => parseDateCases(`${line("2026-10-25T12:30")}\n${line("2026-10-25T12:30")}`)).toThrow(/duplicate id x/);
  });
});
