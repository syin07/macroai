import { z } from "zod";
import type {
  DailySummary,
  Macros,
  NutritionGoals,
  PutGoalsRequest,
  SuggestGoalsRequest,
  SuggestGoalsResponse,
} from "@/types/api";
import { isoDate, timezone } from "./common";
import { macrosSchema, mealListItemSchema } from "./meal";

// Targets a person would plausibly set. Anything outside is almost certainly a typo.
export const putGoalsRequestSchema = z.object({
  calories: z.number().int().min(800).max(10_000),
  protein_g: z.number().finite().min(0).max(1_000),
  carbs_g: z.number().finite().min(0).max(2_000),
  fat_g: z.number().finite().min(0).max(1_000),
}) satisfies z.ZodType<PutGoalsRequest>;

export const nutritionGoalsSchema = macrosSchema.extend({
  effective_from: isoDate,
}) satisfies z.ZodType<NutritionGoals>;

// POST /api/goals/suggest
export const suggestGoalsRequestSchema = z.object({
  age: z.number().int().min(13).max(120),
  height_cm: z.number().finite().min(100).max(250),
  weight_kg: z.number().finite().min(30).max(350),
  sex: z.enum(["male", "female"]),
  activity: z.enum(["sedentary", "light", "moderate", "active", "very_active"]),
  goal: z.enum(["lose", "maintain", "gain"]),
  target_weight_kg: z.number().finite().min(30).max(350).optional(),
}) satisfies z.ZodType<SuggestGoalsRequest>;

export const suggestGoalsResponseSchema = z.object({
  suggested: macrosSchema,
  explanation: z.string(),
}) satisfies z.ZodType<SuggestGoalsResponse>;

// `remaining` may be negative (over target), so it can't reuse macrosSchema's non-negative check.
const signedMacrosSchema = z.object({
  calories: z.number().finite(),
  protein_g: z.number().finite(),
  carbs_g: z.number().finite(),
  fat_g: z.number().finite(),
}) satisfies z.ZodType<Macros>;

export const dailySummarySchema = z.object({
  date: isoDate,
  timezone,
  consumed: macrosSchema,
  targets: macrosSchema.nullable(),
  remaining: signedMacrosSchema.nullable(),
  meals: z.array(mealListItemSchema),
}) satisfies z.ZodType<DailySummary>;
