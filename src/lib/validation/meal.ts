import { z } from "zod";
import type {
  Confidence,
  Macros,
  Meal,
  MealItem,
  MealListItem,
  MealProposal,
  MealSourceType,
  MealsPage,
  NutritionSource,
  SaveMealsRequest,
  UpdateMealRequest,
} from "@/types/api";
import { amount, isoDate, isoDateTime, text, uuid, limitParam } from "./common";

// Sanity caps: generous enough for any real meal, small enough to catch unit mix-ups (kg typed as g).
const MAX_ITEM_GRAMS = 10_000;
const MAX_KCAL = 50_000;
const MAX_MACRO_G = 5_000;
const MAX_ITEMS_PER_MEAL = 50;
const MAX_MEALS_PER_SAVE = 10;

export const nutritionSourceSchema = z.enum([
  "usda",
  "open_food_facts",
  "label",
  "web",
  "ai",
  "manual",
]) satisfies z.ZodType<NutritionSource>;

export const confidenceSchema = z.enum(["high", "medium", "low"]) satisfies z.ZodType<Confidence>;

export const mealSourceTypeSchema = z.enum([
  "text",
  "photo",
  "barcode",
  "manual",
]) satisfies z.ZodType<MealSourceType>;

export const macrosSchema = z.object({
  calories: amount(MAX_KCAL),
  protein_g: amount(MAX_MACRO_G),
  carbs_g: amount(MAX_MACRO_G),
  fat_g: amount(MAX_MACRO_G),
}) satisfies z.ZodType<Macros>;

const mealItemFields = {
  food_name: text(200),
  quantity: z.number().finite().positive().max(MAX_ITEM_GRAMS),
  unit: text(32),
  grams: amount(MAX_ITEM_GRAMS).nullable(),
  basis_per_100g: macrosSchema.nullable(),
  macros: macrosSchema,
  nutrition_source: nutritionSourceSchema,
  source_reference: z.string().max(2048).nullable(),
  inferred: z.boolean(),
  confidence: confidenceSchema.nullable(),
  edited_by_user: z.boolean(),
  assumptions: z.string().max(1000).nullable(),
};

// The server derives macros from basis_per_100g × grams / 100, so a basis without grams can't be used.
function basisNeedsGrams(item: { basis_per_100g: Macros | null; grams: number | null }) {
  return item.basis_per_100g === null || item.grams !== null;
}
const basisNeedsGramsIssue = { message: "grams is required when basis_per_100g is set", path: ["grams"] };

export const mealItemSchema = z
  .object({ id: uuid.nullable(), ...mealItemFields })
  .refine(basisNeedsGrams, basisNeedsGramsIssue) satisfies z.ZodType<MealItem>;

// Item as sent on save (no id yet).
export const mealItemInputSchema = z
  .object(mealItemFields)
  .refine(basisNeedsGrams, basisNeedsGramsIssue) satisfies z.ZodType<Omit<MealItem, "id">>;

export const mealProposalSchema = z.object({
  proposal_id: uuid,
  name: text(120),
  consumed_at: isoDateTime,
  items: z.array(mealItemSchema).max(MAX_ITEMS_PER_MEAL),
  totals: macrosSchema,
  needs_clarification: z.boolean(),
  clarification_question: z.string().max(500).nullable(),
}) satisfies z.ZodType<MealProposal>;

export const mealSchema = z.object({
  id: uuid,
  name: text(120),
  consumed_at: isoDateTime,
  created_at: isoDateTime,
  updated_at: isoDateTime,
  source_type: mealSourceTypeSchema,
  items: z.array(mealItemSchema).max(MAX_ITEMS_PER_MEAL),
  totals: macrosSchema,
  status: z.enum(["active", "pending_deletion"]),
  version: z.number().int().positive(),
}) satisfies z.ZodType<Meal>;

export const mealListItemSchema = z.object({
  id: uuid,
  name: z.string(),
  consumed_at: isoDateTime,
  totals: macrosSchema,
}) satisfies z.ZodType<MealListItem>;

export const mealsPageSchema = z.object({
  meals: z.array(mealListItemSchema),
  next_cursor: z.string().nullable(),
}) satisfies z.ZodType<MealsPage>;

// POST /api/meals
export const saveMealsRequestSchema = z.object({
  meals: z
    .array(
      z.object({
        proposal_id: uuid.nullable(),
        name: text(120),
        consumed_at: isoDateTime,
        source_type: mealSourceTypeSchema,
        items: z.array(mealItemInputSchema).min(1).max(MAX_ITEMS_PER_MEAL),
      }),
    )
    .min(1)
    .max(MAX_MEALS_PER_SAVE),
}) satisfies z.ZodType<SaveMealsRequest>;

export const idempotencyKeySchema = uuid;

// PATCH /api/meals/:id
export const updateMealRequestSchema = z
  .object({
    version: z.number().int().positive(),
    name: text(120).optional(),
    consumed_at: isoDateTime.optional(),
    items: z
      .array(
        z
          .object({ id: uuid.nullable(), ...mealItemFields })
          .refine(basisNeedsGrams, basisNeedsGramsIssue),
      )
      .min(1)
      .max(MAX_ITEMS_PER_MEAL)
      .optional(),
  })
  .refine((body) => body.name !== undefined || body.consumed_at !== undefined || body.items !== undefined, {
    message: "Nothing to update",
  }) satisfies z.ZodType<UpdateMealRequest>;

export const mealIdParamSchema = uuid;

// GET /api/meals?from&to&q&cursor&limit
export const mealsQuerySchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    q: z.string().trim().max(100).optional(),
    cursor: z.string().max(512).optional(),
    limit: limitParam(30, 100),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: "from must be on or before to",
    path: ["from"],
  });

// GET /api/nutrition/daily?date
export const dailyQuerySchema = z.object({
  date: isoDate.optional(),
});
