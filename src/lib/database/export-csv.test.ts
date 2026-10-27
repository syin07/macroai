import { describe, expect, it } from "vitest";
import type { Meal, MealItem } from "@/types/api";
import { CSV_COLUMNS, csvCell, mealsToCsv } from "./export-csv";

const item = (overrides: Partial<MealItem> = {}): MealItem => ({
  id: "a1000000-0000-4000-8000-000000000001",
  food_name: "Banana",
  quantity: 1,
  unit: "piece",
  grams: 118,
  basis_per_100g: { calories: 89, protein_g: 1.09, carbs_g: 22.84, fat_g: 0.33 },
  macros: { calories: 105.02, protein_g: 1.286, carbs_g: 26.951, fat_g: 0.389 },
  nutrition_source: "usda",
  source_reference: "173944",
  inferred: false,
  confidence: null,
  edited_by_user: false,
  assumptions: null,
  ...overrides,
});

const meal = (overrides: Partial<Meal> = {}): Meal => ({
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Breakfast",
  consumed_at: "2026-10-26T05:30:00+00:00",
  created_at: "2026-10-26T05:31:00+00:00",
  updated_at: "2026-10-26T05:31:00+00:00",
  source_type: "text",
  items: [item()],
  totals: { calories: 105.02, protein_g: 1.286, carbs_g: 26.951, fat_g: 0.389 },
  status: "active",
  version: 1,
  ...overrides,
});

// Minimal RFC 4180 parser, to check the output round-trips.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else field += c;
  }
  return rows;
}

const rowsOf = (csv: string) => {
  expect(csv.startsWith("﻿")).toBe(true);
  const [header, ...rows] = parseCsv(csv.slice(1));
  return { header, rows: rows.map((r) => Object.fromEntries(header!.map((h, i) => [h, r[i]]))) };
};

describe("csvCell", () => {
  it.each([
    ["plain", "plain"],
    ["has, comma", '"has, comma"'],
    ['say "hi"', '"say ""hi"""'],
    ["two\nlines", '"two\nlines"'],
    ["cr\rhere", '"cr\rhere"'],
    ["", ""],
  ])("escapes %j", (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });

  it.each([
    ["=1+1", "'=1+1"],
    ["+1", "'+1"],
    ["-1", "'-1"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["\tcmd", "'\tcmd"],
    ['=HYPERLINK("http://evil.example","x")', `"'=HYPERLINK(""http://evil.example"",""x"")"`],
    ["=cmd|' /C calc'!A0, x", `"'=cmd|' /C calc'!A0, x"`],
  ])("defuses formula-looking text %j", (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });

  it("leaves safe text that merely contains formula characters alone", () => {
    expect(csvCell("1+1=2")).toBe("1+1=2");
    expect(csvCell("me@example.com")).toBe("me@example.com");
  });

  it("writes numbers, booleans and nulls plainly", () => {
    expect(csvCell(105.02)).toBe("105.02");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(true)).toBe("true");
    expect(csvCell(false)).toBe("false");
    expect(csvCell(null)).toBe("");
  });
});

describe("mealsToCsv", () => {
  it("writes a header and one row per item with meal columns repeated", () => {
    const csv = mealsToCsv(
      [meal({ items: [item(), item({ id: "a1000000-0000-4000-8000-000000000002", food_name: "Oats" })] })],
      "UTC",
    );
    const { header, rows } = rowsOf(csv);
    expect(header).toEqual([...CSV_COLUMNS]);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        meal_id: "a0000000-0000-4000-8000-000000000001",
        meal_name: "Breakfast",
        source_type: "text",
        meal_calories: "105.02",
      });
    }
    expect(rows.map((r) => [r.item_position, r.food_name])).toEqual([
      ["1", "Banana"],
      ["2", "Oats"],
    ]);
    expect(rows[0]).toMatchObject({
      quantity: "1",
      unit: "piece",
      grams: "118",
      calories: "105.02",
      protein_g: "1.286",
      carbs_g: "26.951",
      fat_g: "0.389",
      nutrition_source: "usda",
      source_reference: "173944",
      inferred: "false",
      confidence: "",
      edited_by_user: "false",
      assumptions: "",
    });
  });

  it("uses CRLF line endings and every row has every column", () => {
    const csv = mealsToCsv([meal(), meal({ items: [] })], "UTC");
    const lines = csv.slice(1).split("\r\n");
    expect(lines.at(-1)).toBe("");
    for (const line of lines.slice(0, -1)) expect(line.split(",")).toHaveLength(CSV_COLUMNS.length);
  });

  it("keeps a meal with no items as one row with empty item columns", () => {
    const { rows } = rowsOf(mealsToCsv([meal({ items: [], name: "Quick add" })], "UTC"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ meal_name: "Quick add", item_id: "", food_name: "", calories: "" });
  });

  it("shows the date and time in the user's zone", () => {
    const { rows } = rowsOf(mealsToCsv([meal()], "America/Los_Angeles"));
    expect(rows[0]).toMatchObject({ date: "2026-10-25", consumed_at: "2026-10-25T22:30:00-07:00" });
  });

  it("round-trips awkward text and defuses formulas in every text column", () => {
    const evil = '=HYPERLINK("http://evil.example","x")';
    const { rows } = rowsOf(
      mealsToCsv(
        [
          meal({
            name: "@SUM(1+1)",
            items: [item({ food_name: evil, unit: "+cup", source_reference: "-1", assumptions: 'medium, "ripe"\nsecond' })],
          }),
        ],
        "UTC",
      ),
    );
    expect(rows[0]).toMatchObject({
      meal_name: "'@SUM(1+1)",
      food_name: `'${evil}`,
      unit: "'+cup",
      source_reference: "'-1",
      assumptions: 'medium, "ripe"\nsecond',
    });
  });

  it("writes only the header for no meals", () => {
    expect(mealsToCsv([], "UTC")).toBe(`﻿${CSV_COLUMNS.join(",")}\r\n`);
  });
});
