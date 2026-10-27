// Model bake-off (PRD §5.4, §16.3): every case through every provider → nutrition lookup → totals.
//
//   npx tsx tests/eval/run-bakeoff.ts [--providers gemini,anthropic,openai] [--only text|photo] [--case <id>]...
//
// Run from the repo root. Needs GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY for the providers
// you select, and USDA_API_KEY. Run compute-truth.ts first for photo cases. Writes
// tests/eval/results/<timestamp>/results.jsonl and summary.md (gitignored).

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { EXTRACT_MEAL_PROMPT_VERSION } from "@/lib/ai/prompts/extract-meal";
import { PROVIDER_NAMES, createProvider, isProviderName } from "@/lib/ai/providers";
import { renderSummary, runBakeoff, summarize, type RunRecord } from "./lib/bakeoff";
import { EVAL_DIR, loadPhotoCases, loadTextCases } from "./lib/cases";
import { loadEnv } from "./lib/env";
import { UsdaApiLookup } from "./lib/nutrition-lookup";

function verdict(record: RunRecord): string {
  if (record.status !== "ok") return `${record.status}: ${record.error}`;
  if (record.text_score) return record.text_score.pass ? "pass" : "fail";
  return `${record.photo_score!.calorie_error_pct.toFixed(1)}% kcal`;
}

async function main() {
  loadEnv();
  const { values } = parseArgs({
    options: {
      providers: { type: "string", default: PROVIDER_NAMES.join(",") },
      only: { type: "string" },
      case: { type: "string", multiple: true },
    },
  });

  const names = values.providers.split(",").map((name) => name.trim());
  const unknown = names.filter((name) => !isProviderName(name));
  if (unknown.length > 0) throw new Error(`Unknown provider(s): ${unknown.join(", ")}. Use ${PROVIDER_NAMES.join(", ")}.`);
  if (values.only && values.only !== "text" && values.only !== "photo") throw new Error("--only must be text or photo");

  const pick = <T extends { id: string }>(cases: T[]) =>
    values.case ? cases.filter((testCase) => values.case!.includes(testCase.id)) : cases;
  const textCases = values.only === "photo" ? [] : pick(await loadTextCases());
  const photoCases = values.only === "text" ? [] : pick(await loadPhotoCases());
  const missingTruth = photoCases.filter((photoCase) => !photoCase.computed).map((photoCase) => photoCase.id);
  if (missingTruth.length > 0) {
    throw new Error(`Run compute-truth.ts first; no truth.computed.json for: ${missingTruth.join(", ")}`);
  }

  const providers = names.filter(isProviderName).map(createProvider);
  const outDir = path.join(EVAL_DIR, "results", new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(outDir, { recursive: true });
  const resultsFile = path.join(outDir, "results.jsonl");
  console.log(
    `${textCases.length} text + ${photoCases.length} photo cases × ${providers.map((p) => p.model).join(", ")} → ${outDir}`,
  );

  const records = await runBakeoff({
    providers,
    lookup: new UsdaApiLookup({ cacheFile: path.join(EVAL_DIR, ".cache", "usda.json") }),
    textCases,
    photoCases,
    onRecord: async (record) => {
      await appendFile(resultsFile, `${JSON.stringify(record)}\n`);
      console.log(`  ${record.provider} ${record.kind}/${record.case_id}: ${verdict(record)} (${record.latency_ms} ms)`);
    },
  });

  const summary = renderSummary(summarize(records), {
    promptVersion: EXTRACT_MEAL_PROMPT_VERSION,
    lookup: "stand-in USDA API lookup (top search hit)",
  });
  await writeFile(path.join(outDir, "summary.md"), summary);
  console.log(`\n${summary}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
