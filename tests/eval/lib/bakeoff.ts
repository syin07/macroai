import { readFile } from "node:fs/promises";
import { ExtractionOutputError, type ExtractionResult, type TokenUsage } from "@/lib/ai/extraction";
import { costUsd } from "@/lib/ai/pricing";
import type { AIProvider, ExtractMealInput, ProviderName } from "@/lib/ai/provider";
import type { Macros } from "@/types/api";
import { DEFAULT_NOW, DEFAULT_TIMEZONE, type PhotoCase, type TextCase } from "./cases";
import type { NutritionLookup } from "./nutrition-lookup";
import { priceExtraction } from "./pipeline";
import { mean, median, percentile, scorePhotoCase, scoreTextCase, type PhotoScore, type TextScore } from "./score";

const RAW_OUTPUT_LIMIT = 4000;

export interface RunRecord {
  provider: ProviderName;
  model: string;
  kind: "text" | "photo";
  case_id: string;
  category: string | null;
  status: "ok" | "invalid_output" | "error";
  latency_ms: number;
  usage: TokenUsage | null;
  cost_usd: number | null;
  error: string | null;
  raw_output: string | null; // only for invalid output, truncated
  result: ExtractionResult | null;
  foods: number | null;
  lookup_hits: number | null; // foods matched in the nutrition database
  predicted_totals: Macros | null;
  text_score: TextScore | null;
  photo_score: PhotoScore | null;
}

interface Attempt {
  status: RunRecord["status"];
  latency_ms: number;
  usage: TokenUsage | null;
  error: string | null;
  raw_output: string | null;
  result: ExtractionResult | null;
}

async function attempt(provider: AIProvider, input: ExtractMealInput): Promise<Attempt> {
  const started = performance.now();
  try {
    const output = await provider.extractMeal(input);
    const latency = performance.now() - started;
    return { status: "ok", latency_ms: latency, usage: output.usage, error: null, raw_output: null, result: output.result };
  } catch (error) {
    const latency = performance.now() - started;
    if (error instanceof ExtractionOutputError) {
      const issues = error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      return {
        status: "invalid_output",
        latency_ms: latency,
        usage: error.usage,
        error: issues ? `${error.message} (${issues})` : error.message,
        raw_output: error.raw.slice(0, RAW_OUTPUT_LIMIT),
        result: null,
      };
    }
    return {
      status: "error",
      latency_ms: latency,
      usage: null,
      error: error instanceof Error ? error.message : String(error),
      raw_output: null,
      result: null,
    };
  }
}

export interface BakeoffOptions {
  providers: AIProvider[];
  lookup: NutritionLookup;
  textCases: TextCase[];
  photoCases: PhotoCase[];
  onRecord?: (record: RunRecord) => void | Promise<void>;
}

// Runs every case through every provider, one request at a time so latency isn't skewed by our own
// concurrency or rate limits.
export async function runBakeoff(options: BakeoffOptions): Promise<RunRecord[]> {
  const records: RunRecord[] = [];
  const emit = async (record: RunRecord) => {
    records.push(record);
    await options.onRecord?.(record);
  };

  for (const provider of options.providers) {
    for (const testCase of options.textCases) {
      const run = await attempt(provider, {
        text: testCase.input,
        now: testCase.now,
        timezone: testCase.timezone,
        memories: testCase.memories,
      });
      const priced = run.result ? await priceExtraction(run.result, options.lookup) : null;
      await emit({
        ...base(provider, run),
        kind: "text",
        case_id: testCase.id,
        category: testCase.category,
        foods: priced?.foods.length ?? null,
        lookup_hits: priced ? priced.foods.filter((food) => food.source === "usda").length : null,
        predicted_totals: priced?.totals ?? null,
        text_score: run.result ? scoreTextCase(testCase, run.result) : null,
        photo_score: null,
      });
    }

    for (const photoCase of options.photoCases) {
      if (!photoCase.computed) throw new Error(`cases/${photoCase.id}: run compute-truth.ts first`);
      // Read per request and drop the bytes afterwards; photos never go into results.
      const bytes = await readFile(photoCase.photoFile);
      const run = await attempt(provider, {
        text: photoCase.truth.caption,
        image: { bytes, mediaType: photoCase.mediaType },
        now: DEFAULT_NOW,
        timezone: DEFAULT_TIMEZONE,
        memories: [],
      });
      const priced = run.result ? await priceExtraction(run.result, options.lookup) : null;
      await emit({
        ...base(provider, run),
        kind: "photo",
        case_id: photoCase.id,
        category: null,
        foods: priced?.foods.length ?? null,
        lookup_hits: priced ? priced.foods.filter((food) => food.source === "usda").length : null,
        predicted_totals: priced?.totals ?? null,
        text_score: null,
        photo_score:
          run.result && priced ? scorePhotoCase(photoCase.truth, photoCase.computed, run.result, priced.totals) : null,
      });
    }
  }
  return records;
}

function base(provider: AIProvider, run: Attempt) {
  return {
    provider: provider.name,
    model: provider.model,
    status: run.status,
    latency_ms: Math.round(run.latency_ms),
    usage: run.usage,
    cost_usd: run.usage ? costUsd(provider.model, run.usage) : null,
    error: run.error,
    raw_output: run.raw_output,
    result: run.result,
  };
}

// --- summary ----------------------------------------------------------------------------------------

export interface ProviderSummary {
  provider: ProviderName;
  model: string;
  text: {
    cases: number;
    errors: number;
    valid_pct: number | null;
    pass_pct: number | null;
    intent_pct: number | null;
    item_recall_pct: number | null;
    grams_ok_pct: number | null;
    lookup_hit_pct: number | null;
    latency_p50_ms: number | null;
    latency_p90_ms: number | null;
    cost_per_1000_usd: number | null;
  };
  photo: {
    cases: number;
    errors: number;
    valid_pct: number | null;
    calorie_abs_error_pct_median: number | null;
    calorie_abs_error_pct_mean: number | null;
    calorie_bias_pct_mean: number | null; // negative = underestimates
    protein_abs_error_g_median: number | null;
    protein_abs_error_g_mean: number | null;
    item_recall_pct: number | null;
    lookup_hit_pct: number | null;
    latency_p50_ms: number | null;
    latency_p90_ms: number | null;
    cost_per_1000_usd: number | null;
  };
}

function pct(part: number, whole: number): number | null {
  return whole === 0 ? null : (part / whole) * 100;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function common(records: RunRecord[]) {
  const answered = records.filter((record) => record.status !== "error");
  const ok = records.filter((record) => record.status === "ok");
  const latencies = answered.map((record) => record.latency_ms);
  const costs = answered.map((record) => record.cost_usd);
  const knownCosts = costs.filter((cost): cost is number => cost !== null);
  return {
    ok,
    cases: records.length,
    errors: records.length - answered.length,
    valid_pct: pct(ok.length, answered.length),
    lookup_hit_pct: pct(sum(ok.map((r) => r.lookup_hits ?? 0)), sum(ok.map((r) => r.foods ?? 0))),
    latency_p50_ms: percentile(latencies, 50),
    latency_p90_ms: percentile(latencies, 90),
    // Unknown if any request's price is unknown, rather than silently averaging a subset.
    cost_per_1000_usd: knownCosts.length === costs.length && costs.length > 0 ? mean(knownCosts)! * 1000 : null,
  };
}

export function summarize(records: RunRecord[]): ProviderSummary[] {
  const providers = [...new Map(records.map((record) => [record.provider, record.model])).entries()];
  return providers.map(([provider, model]) => {
    const mine = records.filter((record) => record.provider === provider);

    const text = common(mine.filter((record) => record.kind === "text"));
    const textScores = text.ok.map((record) => record.text_score!);

    const photo = common(mine.filter((record) => record.kind === "photo"));
    const photoScores = photo.ok.map((record) => record.photo_score!);
    const calorieAbs = photoScores.map((score) => Math.abs(score.calorie_error_pct));
    const proteinAbs = photoScores.map((score) => Math.abs(score.protein_error_g));

    return {
      provider,
      model,
      text: {
        cases: text.cases,
        errors: text.errors,
        valid_pct: text.valid_pct,
        pass_pct: pct(textScores.filter((score) => score.pass).length, text.cases - text.errors),
        intent_pct: pct(textScores.filter((score) => score.intent_ok).length, textScores.length),
        item_recall_pct: pct(sum(textScores.map((s) => s.items_found)), sum(textScores.map((s) => s.items_expected))),
        grams_ok_pct: pct(sum(textScores.map((s) => s.grams_ok)), sum(textScores.map((s) => s.grams_checked))),
        lookup_hit_pct: text.lookup_hit_pct,
        latency_p50_ms: text.latency_p50_ms,
        latency_p90_ms: text.latency_p90_ms,
        cost_per_1000_usd: text.cost_per_1000_usd,
      },
      photo: {
        cases: photo.cases,
        errors: photo.errors,
        valid_pct: photo.valid_pct,
        calorie_abs_error_pct_median: median(calorieAbs),
        calorie_abs_error_pct_mean: mean(calorieAbs),
        calorie_bias_pct_mean: mean(photoScores.map((score) => score.calorie_error_pct)),
        protein_abs_error_g_median: median(proteinAbs),
        protein_abs_error_g_mean: mean(proteinAbs),
        item_recall_pct: pct(sum(photoScores.map((s) => s.items_found)), sum(photoScores.map((s) => s.items_expected))),
        lookup_hit_pct: photo.lookup_hit_pct,
        latency_p50_ms: photo.latency_p50_ms,
        latency_p90_ms: photo.latency_p90_ms,
        cost_per_1000_usd: photo.cost_per_1000_usd,
      },
    };
  });
}

function fmt(value: number | null, digits: number, unit = ""): string {
  return value === null ? "n/a" : `${value.toFixed(digits)}${unit}`;
}

function table(summaries: ProviderSummary[], rows: [string, (summary: ProviderSummary) => string][]): string {
  const header = `| Metric | ${summaries.map((s) => `${s.provider} (\`${s.model}\`)`).join(" | ")} |`;
  const divider = `|---|${summaries.map(() => "---").join("|")}|`;
  return [header, divider, ...rows.map(([label, cell]) => `| ${label} | ${summaries.map(cell).join(" | ")} |`)].join(
    "\n",
  );
}

export function renderSummary(summaries: ProviderSummary[], meta: { promptVersion: string; lookup: string }): string {
  const photo = table(summaries, [
    ["Cases (errors)", (s) => `${s.photo.cases} (${s.photo.errors})`],
    ["Valid JSON", (s) => fmt(s.photo.valid_pct, 0, "%")],
    ["Calorie error, median abs", (s) => fmt(s.photo.calorie_abs_error_pct_median, 1, "%")],
    ["Calorie error, mean abs", (s) => fmt(s.photo.calorie_abs_error_pct_mean, 1, "%")],
    ["Calorie bias, mean signed", (s) => fmt(s.photo.calorie_bias_pct_mean, 1, "%")],
    ["Protein error, median abs", (s) => fmt(s.photo.protein_abs_error_g_median, 1, " g")],
    ["Protein error, mean abs", (s) => fmt(s.photo.protein_abs_error_g_mean, 1, " g")],
    ["Foods identified", (s) => fmt(s.photo.item_recall_pct, 0, "%")],
    ["Foods matched in lookup", (s) => fmt(s.photo.lookup_hit_pct, 0, "%")],
    ["Latency p50 / p90", (s) => `${fmt(s.photo.latency_p50_ms, 0, " ms")} / ${fmt(s.photo.latency_p90_ms, 0, " ms")}`],
    ["$ per 1,000 photos", (s) => fmt(s.photo.cost_per_1000_usd, 2)],
  ]);
  const text = table(summaries, [
    ["Cases (errors)", (s) => `${s.text.cases} (${s.text.errors})`],
    ["Valid JSON", (s) => fmt(s.text.valid_pct, 0, "%")],
    ["Cases fully passed", (s) => fmt(s.text.pass_pct, 0, "%")],
    ["Intent correct", (s) => fmt(s.text.intent_pct, 0, "%")],
    ["Expected foods found", (s) => fmt(s.text.item_recall_pct, 0, "%")],
    ["Stated weights within ±10%", (s) => fmt(s.text.grams_ok_pct, 0, "%")],
    ["Foods matched in lookup", (s) => fmt(s.text.lookup_hit_pct, 0, "%")],
    ["Latency p50 / p90", (s) => `${fmt(s.text.latency_p50_ms, 0, " ms")} / ${fmt(s.text.latency_p90_ms, 0, " ms")}`],
    ["$ per 1,000 requests", (s) => fmt(s.text.cost_per_1000_usd, 2)],
  ]);
  return [
    "# Bake-off run",
    "",
    `Prompt: \`${meta.promptVersion}\` · Nutrition lookup: ${meta.lookup}`,
    "",
    "## Photo cases (weighed meals)",
    "",
    photo,
    "",
    "## Text cases",
    "",
    text,
    "",
    "Calorie and protein errors compare lookup-based totals with weighed USDA truth. Cost is n/a when a model's price isn't in `src/lib/ai/pricing.ts`.",
    "",
  ].join("\n");
}
