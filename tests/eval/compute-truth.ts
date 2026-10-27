// Computes true macros for every weighed photo case from USDA FoodData Central and writes
// cases/<id>/truth.computed.json next to truth.json.
//
//   npx tsx tests/eval/compute-truth.ts            # all cases
//   npx tsx tests/eval/compute-truth.ts <id> ...   # just these
//
// Run from the repo root. Needs USDA_API_KEY (in .env.local or the environment).

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { EVAL_DIR, loadPhotoCases } from "./lib/cases";
import { loadEnv } from "./lib/env";
import { UsdaApiLookup } from "./lib/nutrition-lookup";
import { computeTruth } from "./lib/truth";

async function main() {
  loadEnv();
  const only = new Set(process.argv.slice(2));
  const cases = (await loadPhotoCases()).filter((photoCase) => only.size === 0 || only.has(photoCase.id));
  if (cases.length === 0) {
    console.log("No photo cases found in tests/eval/cases/.");
    return;
  }

  const lookup = new UsdaApiLookup({ cacheFile: path.join(EVAL_DIR, ".cache", "usda.json") });
  for (const photoCase of cases) {
    const computed = await computeTruth(photoCase.truth, lookup);
    await writeFile(path.join(photoCase.dir, "truth.computed.json"), `${JSON.stringify(computed, null, 2)}\n`);
    const { calories, protein_g, carbs_g, fat_g } = computed.totals;
    console.log(
      `${photoCase.id}: ${calories.toFixed(0)} kcal, P ${protein_g.toFixed(1)} g, C ${carbs_g.toFixed(1)} g, F ${fat_g.toFixed(1)} g`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
