import { formatInTimeZone } from "date-fns-tz";
import type { Meal, MealItem } from "@/types/api";
import { isValidTimeZone } from "@/lib/validation/common";

// CSV for GET /api/export?format=csv (PRD FR-18): one row per meal item, with the meal's columns
// repeated on each row. A meal with no items still gets one row so nothing silently disappears.
// Pure: no I/O.

export const CSV_COLUMNS = [
  "meal_id",
  "meal_name",
  "date",
  "consumed_at",
  "source_type",
  "meal_calories",
  "meal_protein_g",
  "meal_carbs_g",
  "meal_fat_g",
  "item_id",
  "item_position",
  "food_name",
  "quantity",
  "unit",
  "grams",
  "calories",
  "protein_g",
  "carbs_g",
  "fat_g",
  "nutrition_source",
  "source_reference",
  "inferred",
  "confidence",
  "edited_by_user",
  "assumptions",
] as const;

type Cell = string | number | boolean | null;

// Spreadsheet apps run a cell starting with one of these as a formula (CSV injection, OWASP). A leading
// apostrophe makes it plain text. Tab and CR are on the list because some apps strip them first.
const FORMULA_START = /^[=+\-@\t\r]/;

// One CSV field, RFC 4180: quote when needed and double embedded quotes. Text cells that could be read
// as formulas are defused first. Numbers and booleans are written as-is (the schema keeps every
// nutrient non-negative, so no number starts with "-").
export function csvCell(value: Cell): string {
  if (value === null) return "";
  if (typeof value !== "string") return String(value);
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(cells: readonly Cell[]): string {
  return cells.map(csvCell).join(",");
}

function itemCells(item: MealItem, position: number): Cell[] {
  return [
    item.id,
    position,
    item.food_name,
    item.quantity,
    item.unit,
    item.grams,
    item.macros.calories,
    item.macros.protein_g,
    item.macros.carbs_g,
    item.macros.fat_g,
    item.nutrition_source,
    item.source_reference,
    item.inferred,
    item.confidence,
    item.edited_by_user,
    item.assumptions,
  ];
}

const EMPTY_ITEM: Cell[] = Array.from({ length: CSV_COLUMNS.length - 9 }, () => null);

// `timezone` turns consumed_at into the user's local date and time, like the rest of the app shows it.
export function mealsToCsv(meals: readonly Meal[], timezone: string): string {
  const zone = isValidTimeZone(timezone) ? timezone : "UTC";
  const lines = [csvRow(CSV_COLUMNS)];
  for (const meal of meals) {
    const consumed = new Date(meal.consumed_at);
    const mealCells: Cell[] = [
      meal.id,
      meal.name,
      formatInTimeZone(consumed, zone, "yyyy-MM-dd"),
      formatInTimeZone(consumed, zone, "yyyy-MM-dd'T'HH:mm:ssXXX"),
      meal.source_type,
      meal.totals.calories,
      meal.totals.protein_g,
      meal.totals.carbs_g,
      meal.totals.fat_g,
    ];
    if (meal.items.length === 0) lines.push(csvRow([...mealCells, ...EMPTY_ITEM]));
    meal.items.forEach((item, index) => lines.push(csvRow([...mealCells, ...itemCells(item, index + 1)])));
  }
  // CRLF per RFC 4180; the BOM makes Excel read the file as UTF-8 (food names aren't all ASCII).
  return `﻿${lines.join("\r\n")}\r\n`;
}
