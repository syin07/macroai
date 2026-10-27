import type { Macros, Meal, MealItem, MealProposal } from "@/types/api";
import {
  mealTotals,
  scaleMacros,
  withDerivedMacros,
} from "@/lib/nutrition/calc";
import { gramsFromTable, normalizeUnit } from "@/lib/nutrition/units";
import { macrosSchema, mealItemSchema } from "@/lib/validation/meal";

export type EditorValue = Pick<
  Meal,
  "name" | "consumed_at" | "items" | "totals"
>;
export type ItemDraft = {
  key: string;
  original: MealItem;
  added: boolean;
  name: string;
  quantity: string;
  unit: string;
  grams: string;
  mode: "original" | "manual" | "label";
  values: Record<keyof Macros, string>;
  edited: boolean;
  portionNote?: string;
  gramsPerQuantity?: number;
};
export type EditorDraft = { name: string; date: string; items: ItemDraft[] };
export const macroFields = [
  ["calories", "Calories (kcal)"],
  ["protein_g", "Protein (g)"],
  ["carbs_g", "Carbs (g)"],
  ["fat_g", "Fat (g)"],
] as const;
export const macroStrings = (macros: Macros) =>
  Object.fromEntries(
    macroFields.map(([key]) => [key, String(macros[key])]),
  ) as Record<keyof Macros, string>;
export function localDateValue(iso: string) {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
export function makeDraft(meal: Meal | MealProposal): EditorDraft {
  return {
    name: meal.name,
    date: localDateValue(meal.consumed_at),
    items: meal.items.map((item, index) => ({
      key: `existing-${index}`,
      original: structuredClone(item),
      added: false,
      name: item.food_name,
      quantity: String(item.quantity),
      unit: item.unit,
      grams: item.grams === null ? "" : String(item.grams),
      gramsPerQuantity:
        item.grams === null ? undefined : item.grams / item.quantity,
      mode:
        item.nutrition_source === "manual" && !item.basis_per_100g
          ? "manual"
          : "original",
      values: macroStrings(item.macros),
      edited: false,
    })),
  };
}
export function newItemDraft(key: string): ItemDraft {
  const empty: Macros = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  return {
    key,
    original: {
      id: null,
      food_name: "",
      quantity: 1,
      unit: "serving",
      grams: null,
      basis_per_100g: null,
      macros: empty,
      nutrition_source: "manual",
      source_reference: null,
      inferred: false,
      confidence: null,
      edited_by_user: true,
      assumptions: null,
    },
    added: true,
    name: "",
    quantity: "1",
    unit: "serving",
    grams: "",
    mode: "manual",
    values: { calories: "", protein_g: "", carbs_g: "", fat_g: "" },
    edited: true,
  };
}
export function changePortion(
  row: ItemDraft,
  field: "quantity" | "unit" | "grams",
  value: string,
): ItemDraft {
  const next = { ...row, [field]: value, edited: true };
  if (field === "grams")
    return {
      ...next,
      portionNote: undefined,
      gramsPerQuantity:
        value.trim() &&
        Number(row.quantity) > 0 &&
        Number.isFinite(Number(value))
          ? Number(value) / Number(row.quantity)
          : undefined,
    };
  const quantity = Number(next.quantity);
  if (
    next.quantity.trim() === "" ||
    !Number.isFinite(quantity) ||
    quantity <= 0
  )
    return field === "unit"
      ? {
          ...next,
          grams: "",
          gramsPerQuantity: undefined,
          portionNote: "Enter a quantity and check grams for this unit.",
        }
      : next;
  if (field === "quantity" && row.gramsPerQuantity !== undefined) {
    next.grams = String(row.gramsPerQuantity * quantity);
    next.portionNote =
      "Weight scaled from the previous portion. Check grams if needed.";
  } else if (field === "unit" || field === "quantity") {
    const resolved = gramsFromTable({
      foodName: row.name,
      quantity,
      unit: next.unit,
    });
    next.grams = resolved ? String(resolved.grams) : "";
    next.gramsPerQuantity = resolved ? resolved.grams / quantity : undefined;
    next.portionNote = resolved
      ? (resolved.note ?? undefined)
      : "Enter grams for this unit.";
  }
  return next;
}
function numeric(value: string, label: string, positive = false): number {
  const parsed = Number(value);
  if (
    !value.trim() ||
    !Number.isFinite(parsed) ||
    (positive ? parsed <= 0 : parsed < 0)
  )
    throw new Error(
      `Enter a ${positive ? "positive" : "non-negative"} number for ${label}.`,
    );
  return parsed;
}
export function buildItem(row: ItemDraft): MealItem {
  const quantity = numeric(row.quantity, "quantity", true);
  const grams = row.grams.trim() ? numeric(row.grams, "grams") : null;
  let item: MealItem = {
    ...row.original,
    food_name: row.name.trim(),
    quantity,
    unit: row.unit.trim(),
    grams,
    edited_by_user: row.edited || row.original.edited_by_user,
    assumptions: row.portionNote
      ? [row.original.assumptions, row.portionNote]
          .filter(Boolean)
          .join("; ")
          .slice(0, 1000)
      : row.original.assumptions,
  };
  if (row.mode !== "original") {
    const values = Object.fromEntries(
      macroFields.map(([key, label]) => [key, numeric(row.values[key], label)]),
    ) as unknown as Macros;
    item = {
      ...item,
      macros: values,
      basis_per_100g: row.mode === "label" ? values : null,
      nutrition_source: row.mode === "label" ? "label" : "manual",
      source_reference: null,
      confidence: null,
      edited_by_user: true,
    };
  } else if (!item.basis_per_100g && item.nutrition_source !== "manual") {
    const original = row.original;
    if (grams !== null && original.grams !== null && original.grams > 0)
      item.macros = scaleMacros(original.macros, grams / original.grams);
    else if (normalizeUnit(item.unit) === normalizeUnit(original.unit))
      item.macros = scaleMacros(original.macros, quantity / original.quantity);
    else
      throw new Error(
        "Use manual macros when an estimated item's unit cannot be converted.",
      );
  }
  const parsed = mealItemSchema.safeParse(item);
  if (!parsed.success)
    throw new Error(
      `${row.name.trim() || "New item"}: ${parsed.error.issues[0].path.join(" ")} ${parsed.error.issues[0].message}`,
    );
  return withDerivedMacros(parsed.data);
}
export function buildValue(
  draft: EditorDraft,
  original: Meal | MealProposal,
): EditorValue {
  if (!draft.name.trim() || draft.name.trim().length > 120)
    throw new Error("Enter a meal name up to 120 characters.");
  if (!draft.items.length || draft.items.length > 50)
    throw new Error("Keep between 1 and 50 items in the meal.");
  const date = new Date(draft.date);
  if (
    !Number.isFinite(date.getTime()) ||
    localDateValue(date.toISOString()) !== draft.date
  )
    throw new Error("Enter a valid date and time in this device’s time zone.");
  const items = draft.items.map(buildItem);
  const totals = mealTotals(items);
  if (!macrosSchema.safeParse(totals).success)
    throw new Error(
      "The meal total exceeds the supported nutrition range. Review the amounts.",
    );
  return {
    name: draft.name.trim(),
    consumed_at:
      draft.date === localDateValue(original.consumed_at)
        ? original.consumed_at
        : date.toISOString(),
    items,
    totals,
  };
}
