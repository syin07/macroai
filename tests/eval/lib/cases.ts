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

export function parseTextCases(jsonl: string): TextCase[] {
  const cases = jsonl
    .split("\n")
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, number }) => {
      const parsed = textCaseSchema.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error(`text-cases.jsonl line ${number}: ${z.prettifyError(parsed.error)}`);
      return parsed.data;
    });
  const ids = new Set<string>();
  for (const testCase of cases) {
    if (ids.has(testCase.id)) throw new Error(`text-cases.jsonl: duplicate id ${testCase.id}`);
    ids.add(testCase.id);
  }
  return cases;
}

export async function loadTextCases(file = TEXT_CASES_FILE): Promise<TextCase[]> {
  return parseTextCases(await readFile(file, "utf8"));
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
