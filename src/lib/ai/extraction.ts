import { z } from "zod";
import { amount, isoDateTime, text } from "@/lib/validation/common";
import { confidenceSchema } from "@/lib/validation/meal";

// What the model returns from extractMeal (PRD §5.6). Internal to the AI pipeline, not part of the
// API contract: B6 turns it into MealProposal[] after USDA matching and server-side math.
//
// Provider-neutral on purpose: every field is required (nullable instead of optional) and objects
// are closed, which is what strict structured-output modes need. Bounds live here in Zod; they are
// stripped from the JSON Schema sent to providers (see extractionJsonSchema) and enforced on parse.

const MAX_GRAMS = 10_000;
const MAX_KCAL = 20_000;
const MAX_MACRO_G = 2_000;
const MAX_FOODS_PER_MEAL = 30;
const MAX_MEALS = 10;

export const extractionIntentSchema = z
  .enum(["log_meal", "correction", "question", "other"])
  .describe(
    "log_meal: the user ate or is eating/drinking something. correction: changes a meal already logged. " +
      "question: asks something, including hypotheticals like 'should I eat pizza?'. other: anything else.",
  );

const estimatedMacrosSchema = z
  .object({
    calories: amount(MAX_KCAL),
    protein_g: amount(MAX_MACRO_G),
    carbs_g: amount(MAX_MACRO_G),
    fat_g: amount(MAX_MACRO_G),
  })
  .describe("Your own estimate for this food at this portion. Used only if no database match is found.");

const estimateRangeSchema = z
  .object({
    calories_low: amount(MAX_KCAL),
    calories_high: amount(MAX_KCAL),
    protein_g_low: amount(MAX_MACRO_G),
    protein_g_high: amount(MAX_MACRO_G),
  })
  .describe("Plausible low/high bounds for this food's calories and protein, reflecting portion uncertainty.");

export const extractedFoodSchema = z.object({
  name: text(200).describe("Specific food name, e.g. 'Cooked chicken breast'."),
  brand: z.string().trim().max(100).nullable().describe("Brand or restaurant if named or visible, else null."),
  quantity: z.number().finite().positive().max(MAX_GRAMS).describe("Amount in `unit`, as stated or estimated."),
  unit: text(32).describe("Unit for quantity: 'g', 'ml', 'cup', 'tbsp', 'slice', 'scoop', 'egg', 'piece', ..."),
  grams: z
    .number()
    .finite()
    .positive()
    .max(MAX_GRAMS)
    .nullable()
    .describe("Estimated edible weight in grams as eaten (cooked weight for cooked food). Null only if impossible."),
  preparation: z.string().trim().max(100).nullable().describe("raw, boiled, grilled, fried, baked, ... or null."),
  estimated_quantity: z.boolean().describe("true if the amount was not stated by the user."),
  inferred: z.boolean().describe("true for a likely hidden ingredient (oil, butter, dressing) that was not stated or seen."),
  confidence: confidenceSchema,
  search_query: text(200).describe("USDA FoodData Central style query, e.g. 'chicken, breast, grilled'."),
  estimated_macros: estimatedMacrosSchema,
  estimate_range: estimateRangeSchema,
  notes: z.string().trim().max(500).nullable().describe("Assumptions worth showing the user, else null."),
});

export const extractedMealSchema = z.object({
  name: text(120).describe("Short meal name, e.g. 'Eggs and Toast'."),
  consumed_at: isoDateTime
    .nullable()
    .describe("When it was eaten, ISO 8601 with UTC offset, resolved against the current time. Null if not mentioned."),
  time_phrase: z
    .string()
    .trim()
    .max(100)
    .nullable()
    .describe("The user's own words for the time, e.g. 'last night', else null."),
  foods: z.array(extractedFoodSchema).min(1).max(MAX_FOODS_PER_MEAL),
  needs_clarification: z.boolean(),
  clarification_question: z.string().trim().max(300).nullable().describe("One short question, only if needed."),
});

export const extractionResultSchema = z.object({
  intent: extractionIntentSchema,
  meals: z.array(extractedMealSchema).max(MAX_MEALS).describe("Empty unless intent is log_meal."),
  explanation: z
    .string()
    .trim()
    .max(500)
    .nullable()
    .describe("Short reason when no meals are returned (hypothetical, not food, unreadable photo), else null."),
});

export type ExtractionIntent = z.infer<typeof extractionIntentSchema>;
export type ExtractedFood = z.infer<typeof extractedFoodSchema>;
export type ExtractedMeal = z.infer<typeof extractedMealSchema>;
export type ExtractionResult = z.infer<typeof extractionResultSchema>;

// Keywords some structured-output modes reject. Zod still enforces all of them on parse.
const UNSUPPORTED_KEYWORDS = new Set([
  "$schema",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "pattern",
  "format",
]);

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function toProviderSchema(node: JsonValue): JsonValue {
  if (Array.isArray(node)) return node.map(toProviderSchema);
  if (node === null || typeof node !== "object") return node;

  const out: { [key: string]: JsonValue } = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    // `properties` maps names to schemas; recurse into each schema, not into the map as if it were one.
    out[key] =
      key === "properties" && value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, toProviderSchema(schema)]))
        : toProviderSchema(value);
  }
  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties);
  }
  return out;
}

// JSON Schema for the providers' structured-output modes. Same schema for every candidate so the
// bake-off compares models, not schemas.
export const extractionJsonSchema = toProviderSchema(
  z.toJSONSchema(extractionResultSchema, { io: "output" }) as JsonValue,
) as Record<string, unknown>;

export const EXTRACTION_SCHEMA_NAME = "meal_extraction";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number; // includes reasoning / thinking tokens, which are billed as output
}

// Why there's no ExtractionResult. refusal / max_tokens / safety come from the provider's stop reason and
// are checked before parsing, so they're never mistaken for malformed JSON; retrying them rarely helps.
export type ExtractionFailure = "invalid_json" | "schema_mismatch" | "refusal" | "max_tokens" | "safety";

// The model answered, but not with a valid ExtractionResult. Carries the raw text and token usage so
// callers can retry (B6) or score it as invalid (bake-off) without losing the cost.
export class ExtractionOutputError extends Error {
  constructor(
    message: string,
    readonly raw: string,
    readonly usage: TokenUsage,
    readonly issues: z.core.$ZodIssue[] = [],
    readonly failure: ExtractionFailure = issues.length > 0 ? "schema_mismatch" : "invalid_json",
  ) {
    super(message);
    this.name = "ExtractionOutputError";
  }
}

export function parseExtractionOutput(raw: string, usage: TokenUsage): ExtractionResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ExtractionOutputError("Model output is not valid JSON", raw, usage);
  }
  const parsed = extractionResultSchema.safeParse(json);
  if (!parsed.success) {
    throw new ExtractionOutputError("Model output does not match the extraction schema", raw, usage, parsed.error.issues);
  }
  return parsed.data;
}
