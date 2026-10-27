import { expect, it } from "vitest";
import { createFixtures } from "@/mocks/fixtures";
import {
  buildValue,
  changePortion,
  makeDraft,
  newItemDraft,
} from "./editor-draft";

const f = createFixtures(new Date("2026-10-26T12:30:25Z"));
it("recalculates grams and quantity changes with the shared database math without mutating the proposal", () => {
  const draft = makeDraft(f.single);
  draft.items[0] = changePortion(draft.items[0], "grams", "320");
  expect(buildValue(draft, f.single).totals.calories).toBe(640);
  expect(f.single.items[0].grams).toBe(160);
  const quantity = makeDraft(f.single);
  quantity.items[0] = changePortion(quantity.items[0], "quantity", "2");
  expect(buildValue(quantity, f.single).items[0]).toMatchObject({
    quantity: 2,
    grams: 320,
    edited_by_user: true,
  });
  expect(buildValue(quantity, f.single).totals.calories).toBe(640);
  expect(buildValue(quantity, f.single).consumed_at).toBe(f.single.consumed_at);
});
it("converts mass units and requires an explicit weight for unknown units", () => {
  const draft = makeDraft(f.single);
  draft.items[0] = changePortion(draft.items[0], "unit", "oz");
  expect(buildValue(draft, f.single).items[0].grams).toBeCloseTo(28.3495, 3);
  draft.items[0] = changePortion(draft.items[0], "unit", "mystery bowl");
  expect(() => buildValue(draft, f.single)).toThrow(/grams/);
});

it("keeps the known portion ratio while a quantity input is cleared and retyped", () => {
  const draft = makeDraft(f.single);
  draft.items[0] = changePortion(draft.items[0], "quantity", "");
  expect(() => buildValue(draft, f.single)).toThrow(/quantity/);
  draft.items[0] = changePortion(draft.items[0], "quantity", "2");
  expect(buildValue(draft, f.single).totals.calories).toBe(640);
});
it("keeps manual overrides authoritative instead of reapplying the database basis", () => {
  const draft = makeDraft(f.single);
  draft.items[0] = {
    ...draft.items[0],
    mode: "manual",
    grams: "320",
    values: { calories: "123", protein_g: "10", carbs_g: "20", fat_g: "3" },
  };
  const item = buildValue(draft, f.single).items[0];
  expect(item).toMatchObject({
    nutrition_source: "manual",
    basis_per_100g: null,
    source_reference: null,
    confidence: null,
    edited_by_user: true,
    macros: { calories: 123, protein_g: 10, carbs_g: 20, fat_g: 3 },
  });
});
it("adds labeled nutrition per 100 g and rejects incomplete or negative new foods", () => {
  const draft = makeDraft(f.single);
  const row = {
    ...newItemDraft("new"),
    name: "Yogurt",
    grams: "200",
    mode: "label" as const,
    values: { calories: "80", protein_g: "8", carbs_g: "5", fat_g: "3" },
  };
  draft.items.push(row);
  expect(buildValue(draft, f.single).totals.calories).toBe(480);
  expect(buildValue(draft, f.single).items[1]).toMatchObject({
    id: null,
    nutrition_source: "label",
    macros: { calories: 160, protein_g: 16, carbs_g: 10, fat_g: 6 },
  });
  draft.items[1] = { ...row, values: { ...row.values, calories: "" } };
  expect(() => buildValue(draft, f.single)).toThrow(/Calories/);
  draft.items[1] = { ...row, values: { ...row.values, calories: "-1" } };
  expect(() => buildValue(draft, f.single)).toThrow(/non-negative/);
});
it("scales an AI-only estimate by its known weight without relabeling it as database nutrition", () => {
  const proposal = structuredClone(f.single);
  proposal.items[0] = {
    ...proposal.items[0],
    basis_per_100g: null,
    nutrition_source: "ai",
  };
  const draft = makeDraft(proposal);
  draft.items[0].grams = "80";
  expect(buildValue(draft, proposal).items[0]).toMatchObject({
    nutrition_source: "ai",
    basis_per_100g: null,
    macros: { calories: 160, protein_g: 10, carbs_g: 15, fat_g: 7 },
  });
});
it.each(["", "2026-02-30T10:00", "bad date"])(
  "rejects an invalid consumed time: %s",
  (date) => {
    const draft = makeDraft(f.single);
    draft.date = date;
    expect(() => buildValue(draft, f.single)).toThrow(/date and time/);
  },
);
