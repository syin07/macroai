import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { extractionIntentSchema } from "@/lib/ai/extraction";
import type { ImageMediaType } from "@/lib/ai/provider";
import { isoDate, isoDateTime, timezone } from "@/lib/validation/common";
import { macrosSchema } from "@/lib/validation/meal";

export const EVAL_DIR = path.join(process.cwd(), "tests", "eval");
export const TEXT_CASES_FILE = path.join(EVAL_DIR, "text-cases.jsonl");
export const PHOTO_CASES_DIR = path.join(EVAL_DIR, "cases");

// Fixed clock so date phrases ("last night") resolve the same way on every run.
export const DEFAULT_NOW = "2026-10-26T12:30:00-07:00";
export const DEFAULT_TIMEZONE = "America/Los_Angeles";

// --- text cases (text-cases.jsonl, one JSON object per line) -----------------------------------------

const expectedItemSchema = z.object({
  // The item counts as found if the predicted food name or search_query contains any of these.
  match: z.array(z.string().min(1)).min(1),
  // Only for weights the input states exactly ("150g", "3 oz"); checked within ±10%.
  grams: z.number().positive().optional(),
});

export const textCaseSchema = z.object({
  id: z.string().min(1),
  category: z.enum([
    "simple",
    "multi_item",
    "informal_units",
    "explicit_weight",
    "multi_meal",
    "hypothetical",
    "question",
    "correction",
    "not_food",
    "hidden_fat",
    "branded",
    "restaurant",
    "memory",
    "date_phrase",
    "ambiguous",
  ]),
  input: z.string().min(1),
  now: isoDateTime.default(DEFAULT_NOW),
  timezone: timezone.default(DEFAULT_TIMEZONE),
  memories: z.array(z.string()).default([]),
  expected_intent: extractionIntentSchema.default("log_meal"),
  expected_meals: z.number().int().min(0),
  expected_items: z.array(expectedItemSchema),
  expect_inferred: z.boolean().optional(),        // true: at least one inferred item; false: none
  expect_clarification: z.boolean().optional(),
  expected_local_date: isoDate.optional(),        // consumed_at's date in `timezone`
});

export type TextCase = z.infer<typeof textCaseSchema>;
export type ExpectedItem = z.infer<typeof expectedItemSchema>;

// One JSON object per line, each validated by `schema`, with unique `id`s.
function parseJsonl<T extends { id: string }>(fileName: string, jsonl: string, schema: z.ZodType<T>): T[] {
  const cases = jsonl
    .split("\n")
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, number }) => {
      const parsed = schema.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error(`${fileName} line ${number}: ${z.prettifyError(parsed.error)}`);
      return parsed.data;
    });
  const ids = new Set<string>();
  for (const testCase of cases) {
    if (ids.has(testCase.id)) throw new Error(`${fileName}: duplicate id ${testCase.id}`);
    ids.add(testCase.id);
  }
  return cases;
}

export function parseTextCases(jsonl: string): TextCase[] {
  return parseJsonl("text-cases.jsonl", jsonl, textCaseSchema);
}

export async function loadTextCases(file = TEXT_CASES_FILE): Promise<TextCase[]> {
  return parseTextCases(await readFile(file, "utf8"));
}

// --- date cases (date-cases.jsonl): run through the date resolver in code, no model -----------------

export const DATE_CASES_FILE = path.join(EVAL_DIR, "date-cases.jsonl");

export const datePhraseSchema = z.enum([
  "yesterday",
  "last_night",
  "this_morning",
  "hours_ago",
  "last_weekday",
  "at_clock_time",
]);

export const dateCaseSchema = z.object({
  id: z.string().min(1),
  phrase: datePhraseSchema,                      // which of the six PRD FR-09 phrasings this exercises
  input: z.string().min(1),                       // the user's time words, as the model puts them in time_phrase
  now: isoDateTime,
  timezone,
  // The expected consumed_at as a wall-clock time in `timezone`, "YYYY-MM-DDTHH:mm".
  expected_local: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "expected YYYY-MM-DDTHH:mm"),
  note: z.string().optional(),
});

export type DateCase = z.infer<typeof dateCaseSchema>;

export function parseDateCases(jsonl: string): DateCase[] {
  return parseJsonl("date-cases.jsonl", jsonl, dateCaseSchema);
}

export async function loadDateCases(file = DATE_CASES_FILE): Promise<DateCase[]> {
  return parseDateCases(await readFile(file, "utf8"));
}

// --- correction cases (correction-cases.jsonl): data for the B10 chat runner ------------------------

export const CORRECTION_CASES_FILE = path.join(EVAL_DIR, "correction-cases.jsonl");

const fixtureItemSchema = z.object({
  id: z.string().min(1),                          // readable label; the runner maps it to a UUID when seeding
  name: z.string().min(1),
  quantity: z.number().positive(),
  unit: z.string().min(1),
  grams: z.number().positive(),
  macros: macrosSchema,
});

const fixtureMealSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  consumed_at: isoDateTime,
  version: z.number().int().positive(),
  items: z.array(fixtureItemSchema).min(1),
});

const updateExpectationSchema = z.object({
  kind: z.literal("update"),
  tool: z.literal("update_meal"),
  meal_id: z.string().min(1),
  version: z.number().int().positive(),           // must equal the fixture meal's version (PRD 12.14)
  removed_items: z.array(z.string().min(1)).optional(),
  scale_all: z.number().positive().optional(),    // every item's grams × this
  item_grams: z.record(z.string(), z.number().positive()).optional(),     // within ±5%
  item_quantity: z.record(z.string(), z.number().positive()).optional(),
  item_renamed: z.record(z.string(), z.array(z.string().min(1)).min(1)).optional(), // new name has any keyword
  consumed_local_date: isoDate.optional(),        // in the case's time zone
  consumed_local_hours: z.tuple([z.number().int().min(0).max(23), z.number().int().min(0).max(24)]).optional(),
  time_phrase: z.string().min(1).optional(),      // what the date resolver gets for a date move
  totals: z.object({ calories: z.enum(["down", "up", "same"]) }).optional(),
});

const deleteExpectationSchema = z.object({
  kind: z.literal("delete"),
  tool: z.literal("delete_meal"),
  meal_id: z.string().min(1),
});

const clarificationExpectationSchema = z.object({
  kind: z.literal("clarification"),
  candidate_meal_ids: z.array(z.string().min(1)).min(2),
});

export const correctionExpectationSchema = z.discriminatedUnion("kind", [
  updateExpectationSchema,
  deleteExpectationSchema,
  clarificationExpectationSchema,
]);

export const correctionCaseSchema = z.object({
  id: z.string().min(1),
  input: z.string().min(1),
  now: isoDateTime.default(DEFAULT_NOW),
  timezone: timezone.default(DEFAULT_TIMEZONE),
  // Earlier turns in the chat, oldest first, for corrections that refer back ("I only ate half").
  recent_messages: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().min(1) })).default([]),
  // The user's last few saved meals, newest first, as B10's context will show them (at most 5).
  recent_meals: z.array(fixtureMealSchema).min(1).max(5),
  expected: correctionExpectationSchema,
  note: z.string().optional(),
});

export type CorrectionCase = z.infer<typeof correctionCaseSchema>;
export type CorrectionExpectation = z.infer<typeof correctionExpectationSchema>;

export function parseCorrectionCases(jsonl: string): CorrectionCase[] {
  return parseJsonl("correction-cases.jsonl", jsonl, correctionCaseSchema);
}

export async function loadCorrectionCases(file = CORRECTION_CASES_FILE): Promise<CorrectionCase[]> {
  return parseCorrectionCases(await readFile(file, "utf8"));
}

// --- photo cases (cases/<id>/photo.jpg + truth.json) ------------------------------------------------

export const truthSchema = z.object({
  items: z
    .array(
      z.object({
        name: z.string().min(1),
        grams: z.number().positive(), // weighed before combining
        fdc_id: z.number().int().positive(),
        aliases: z.array(z.string().min(1)).optional(), // extra names that count as identifying it
      }),
    )
    .min(1),
  notes: z.string().optional(),
  caption: z.string().optional(), // text sent with the photo, if any
});

export type Truth = z.infer<typeof truthSchema>;

// Written by compute-truth.ts next to truth.json.
export const computedTruthSchema = z.object({
  computed_at: isoDateTime,
  items: z.array(
    z.object({
      name: z.string(),
      grams: z.number(),
      fdc_id: z.number(),
      usda_description: z.string(),
      basis_per_100g: macrosSchema,
      macros: macrosSchema,
    }),
  ),
  totals: macrosSchema,
});

export type ComputedTruth = z.infer<typeof computedTruthSchema>;

export interface PhotoCase {
  id: string;
  dir: string;
  photoFile: string;
  mediaType: ImageMediaType;
  truth: Truth;
  computed: ComputedTruth | null; // null until compute-truth.ts has run
}

const PHOTO_TYPES: Record<string, ImageMediaType> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export async function loadPhotoCases(dir = PHOTO_CASES_DIR): Promise<PhotoCase[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const cases: PhotoCase[] = [];
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const caseDir = path.join(dir, entry.name);
    const files = await readdir(caseDir);
    const photo = files.find((file) => file.startsWith("photo.") && path.extname(file).toLowerCase() in PHOTO_TYPES);
    if (!photo || !files.includes("truth.json")) {
      console.warn(`Skipping cases/${entry.name}: needs photo.(jpg|png|webp) and truth.json`);
      continue;
    }
    const truth = truthSchema.parse(JSON.parse(await readFile(path.join(caseDir, "truth.json"), "utf8")));
    const computed = files.includes("truth.computed.json")
      ? computedTruthSchema.parse(JSON.parse(await readFile(path.join(caseDir, "truth.computed.json"), "utf8")))
      : null;
    cases.push({
      id: entry.name,
      dir: caseDir,
      photoFile: path.join(caseDir, photo),
      mediaType: PHOTO_TYPES[path.extname(photo).toLowerCase()]!,
      truth,
      computed,
    });
  }
  return cases;
}
