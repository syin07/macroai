# Model bake-off results

Plan step B4 · PRD §5.4, §16.3 · Run 2026-10-26 · Prompt `extract-meal-v1` · Nutrition lookup: B5 matcher (`src/lib/nutrition/match.ts`) over the USDA FDC API

## Decision

- **Winner: Claude Haiku 5.5 (`claude-haiku-5-5`), so `AI_PROVIDER=anthropic`.** It passed all 25 text cases with no errors. It was also the fastest (p50 2.7 s) and the cheapest per request ($0.76 per 1,000).
- **Runner-up / fallback: Gemini 3.1 Flash-Lite (`gemini-3.1-flash-lite`).** Every case it answered was correct. But 13 of its 35 calls failed with `503 UNAVAILABLE` ("high demand") or `504 DEADLINE_EXCEEDED`, and it was about 2× slower.
- **OpenAI `gpt-5.4-mini` was not fully run.** To keep spend low, it only ran the 1-case smoke test, which it passed. At about $4.46 per 1,000 requests it costs roughly 6× what Haiku does.

## What was measured

There is **no weighed-photo test set** (decided 2026-10-26), so these results cover text extraction only:
- whether the intent is right
- how many meals were found
- whether every expected food was found
- whether stated weights came back within ±10%
- whether hidden fats were inferred
- whether the model asked for clarification when it should
- whether dates were resolved correctly

Calorie and protein error against weighed truth **could not be measured**. See [Calorie error](#calorie-error) for a spot check. Each case went through the real pipeline: the model's extraction, then the B5 matcher, then `calc.ts` totals.

## Text cases (25)

| Metric | Claude Haiku 5.5 | Gemini 3.1 Flash-Lite |
|---|---|---|
| Cases answered (API errors) | 25 (0) | 21 (4, after one re-run of failures) |
| Valid JSON / schema | 100% | 100% |
| Cases fully passed (of answered) | 100% | 100% |
| Intent correct | 100% | 100% |
| Expected foods found | 100% | 100% |
| Stated weights within ±10% | 100% | 100% |
| Foods matched in USDA (B5 matcher) | 91% | 91% |
| API error rate (all calls, incl. re-run) | 0% (0/26) | 37% (13/35) |
| Latency p50 / p90 | 2,678 ms / 5,961 ms | 5,466 ms / 10,933 ms |
| Avg tokens in / out | 4,503 / 629 | 1,614 / 599 |
| **$ per 1,000 requests** | **$0.76** | **$1.30** |
| Calorie error, median / mean abs | not measured | not measured |
| Protein error, median / mean abs | not measured | not measured |

Prices come from `src/lib/ai/pricing.ts`:

| Model | Input, per 1M tokens | Output, per 1M tokens | Source |
|---|---|---|---|
| Haiku 5.5 | $0.10 | $0.50 | PRD Appendix A.1 |
| Flash-Lite | $0.25 | $1.50 | PRD Appendix A.1 |
| `gpt-5.4-mini` | $0.75 | $4.50 | developers.openai.com/api/docs/pricing, checked 2026-10-26 |

The Gemini column merges the main run with a single re-run of its 9 failed cases. 5 of those 9 then passed. The other 4 (`t09-three-meals`, `t11-should-i-eat-pizza`, `t17-stir-fry`, `t25-some-chicken`) failed again with 503 or 504 errors and were not retried. Rejected requests aren't billed.

OpenAI smoke test (`t04-prd-breakfast` only): passed, 5.8 s, $0.0045 per request, 3 of 4 foods matched in USDA.

### Calorie error

There is no ground truth, so only one quick check was possible. `t03-explicit-grams` ("150g grilled chicken breast and 200g cooked white rice") is about **507 kcal / 52 g protein** using USDA SR Legacy values (roasted chicken breast 165 kcal and 31 g protein per 100 g; cooked white rice 130 kcal and 2.7 g per 100 g).

| Model | Total | Error |
|---|---|---|
| Haiku | 487 kcal / 51 g | −4% |
| Gemini | 527 kcal / 51 g | +4% (it added an inferred teaspoon of oil) |

On 13 of the 16 meal cases both models answered, their totals are within about 11% of each other. The three exceptions are:
- `t04` breakfast: Haiku 614 vs Gemini 440 kcal
- `t16` salmon: Haiku 378 vs Gemini 485 kcal
- `t24` steak and quinoa: Haiku 465 vs Gemini 370 kcal

In each, the two models assumed different portion sizes, which is not an extraction error. Measuring calorie error properly needs weighed photos, which are still to come (PRD §20).

## Why Haiku

- **Reliability decides it.** Both models were equally accurate on the cases they answered. But Gemini Flash-Lite's 37% capacity-error rate on 2026-10-26 would surface as failed logs or retries for users. This may be a temporary spike, which is why Gemini stays the fallback rather than being ruled out.
- **Cheaper even with more input tokens.** Haiku is billed for about 2.8× the input tokens (4.5K vs 1.6K per request), because the structured-output schema and tokenizer differ. It's still cheaper per request. `EXTRACT_MEAL_SYSTEM_PROMPT` never changes between requests, so prompt caching in B6 should cut input cost further.
- **Faster.** About half Gemini's latency at both p50 and p90.

## Data policy: Anthropic API (winner)

Checked 2026-10-26.

- **Training:** API inputs and outputs aren't used for training. "Retained data is never used for model training without your express permission" ([API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)).
- **Retention:** Anthropic "automatically delete[s] inputs and outputs on our backend within 30 days of receipt or generation" ([commercial data retention](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)). The exceptions:
  - content flagged for Usage Policy violations is kept up to 2 years, and its classifier scores up to 7 years
  - legal requirements
  - "Covered Models" (Fable / Mythos) require 30-day retention. Haiku 5.5 isn't one of them.
- **Zero data retention:** available for `/v1/messages`, including structured outputs and images, but only by per-organization agreement with Anthropic. Our account doesn't have it. For our use, that means a meal photo sent to the API may sit on Anthropic's backend for up to 30 days, even though we never store it ourselves (PRD FR-15).
- **Don't put personal data in the JSON schema.** Structured-output schemas are compiled and cached separately from message content. Ours holds no user data.

Fallback note: Gemini only keeps API traffic out of training on the **paid tier**. Set up billing before using it in production (see the comment in `src/lib/ai/providers/gemini.ts`).

## Cost of this bake-off

$0.054 in total across 62 model calls:

| Run | Spend |
|---|---|
| 3-call smoke test | $0.0074 |
| Main run (Gemini + Haiku × 25) | $0.0402 |
| Gemini re-run of 9 failures | $0.0063 |

## Re-running

```bash
npx tsx tests/eval/run-bakeoff.ts --only text --providers anthropic,gemini --max-usd 0.10
```

Results go to `tests/eval/results/<timestamp>/`, which is gitignored. Re-run the bake-off whenever the prompt or model changes (PRD §16.3).
