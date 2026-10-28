// B10 correction cases against a real model (opt-in; costs money). The same harness as the CI runner
// (lib/correction-cases.test.ts) — real chat turn, real tools, in-memory database — with the scripted
// model swapped for a provider, so this measures whether the model picks the right meal, item, and
// version, and asks when it should.
//
//   npx tsx tests/eval/run-corrections.ts [--provider anthropic|gemini|openai] [--case <id>]... [--max-usd 0.05]
//
// --max-usd is a hard cap on model spend for this run (default $0.05): no model call starts once the
// tokens billed so far reach it. A model without a price in src/lib/ai/pricing.ts is refused. A full run
// is 8 cases × 2-3 calls of ~5K input tokens. Needs the provider's API key; no USDA key (the lookup is
// the harness's fixed list). Prints one line per case.

import { parseArgs } from "node:util";
import { costUsd, MODEL_PRICES } from "@/lib/ai/pricing";
import type { AIProvider } from "@/lib/ai/provider";
import { createProvider, isProviderName, PROVIDER_NAMES } from "@/lib/ai/providers";
import { loadCorrectionCases } from "./lib/cases";
import { checkCorrection, runCorrectionCase } from "./lib/corrections";
import { loadEnv } from "./lib/env";

const DEFAULT_MAX_USD = 0.05;

class BudgetReached extends Error {}

function capped(provider: AIProvider, maxUsd: number, spent: { usd: number }): AIProvider {
  return {
    name: provider.name,
    model: provider.model,
    extractMeal: () => {
      throw new Error("corrections never extract");
    },
    async chat(input) {
      if (spent.usd >= maxUsd) throw new BudgetReached(`spend cap $${maxUsd.toFixed(2)} reached`);
      const turn = await provider.chat(input);
      spent.usd += costUsd(turn.model, turn.usage) ?? Infinity;
      return turn;
    },
  };
}

async function main() {
  loadEnv();
  const { values } = parseArgs({
    options: {
      provider: { type: "string", default: "anthropic" },
      case: { type: "string", multiple: true },
      "max-usd": { type: "string", default: String(DEFAULT_MAX_USD) },
    },
  });
  const maxUsd = Number(values["max-usd"]);
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error("--max-usd must be a positive number");
  if (!isProviderName(values.provider)) throw new Error(`Unknown provider ${values.provider}. Use ${PROVIDER_NAMES.join(", ")}.`);
  const provider = createProvider(values.provider);
  if (!MODEL_PRICES[provider.model]) throw new Error(`No price in src/lib/ai/pricing.ts for ${provider.model}; can't cap spend`);

  const all = await loadCorrectionCases();
  const cases = values.case ? all.filter((c) => values.case!.includes(c.id)) : all;
  console.log(`${cases.length} correction cases × ${provider.model} (cap $${maxUsd.toFixed(2)})`);

  const spent = { usd: 0 };
  let passed = 0;
  for (const testCase of cases) {
    try {
      const outcome = await runCorrectionCase(testCase, capped(provider, maxUsd, spent));
      const problems = checkCorrection(testCase, outcome);
      if (problems.length === 0) passed += 1;
      const calls = outcome.toolCalls.map((call) => call.name).join(", ") || "no tools";
      console.log(`${problems.length === 0 ? "pass" : "FAIL"}  ${testCase.id}  [${calls}]  "${outcome.text.slice(0, 120)}"`);
      for (const problem of problems) console.log(`        - ${problem}`);
    } catch (error) {
      if (error instanceof BudgetReached || (error instanceof Error && error.cause instanceof BudgetReached)) {
        console.log(`stopped: spend cap reached before ${testCase.id}`);
        break;
      }
      console.log(`ERROR ${testCase.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`${passed}/${cases.length} passed, ~$${spent.usd.toFixed(4)} spent`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
