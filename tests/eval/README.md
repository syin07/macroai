# AI eval and model bake-off

Plan step B4; PRD §5.4 and §16.3. Run everything from the repo root. Keys are read from `.env.local` or the environment.

```bash
npx tsx tests/eval/compute-truth.ts                    # USDA truth for photo cases (USDA_API_KEY)
npx tsx tests/eval/run-bakeoff.ts                      # all cases × gemini, anthropic, openai
npx tsx tests/eval/run-bakeoff.ts --providers anthropic --only text --case t09-three-meals
```

Output goes to `results/<timestamp>/` (gitignored): `results.jsonl` has one record per case × provider, and `summary.md` has the tables for `docs/bakeoff-results.md`.

## Text cases: `text-cases.jsonl`

One JSON object per line. The schema is `textCaseSchema` in `lib/cases.ts`.

```json
{"id":"t03-explicit-grams","category":"explicit_weight","input":"150g grilled chicken breast and 200g cooked white rice","expected_meals":1,"expected_items":[{"match":["chicken"],"grams":150},{"match":["rice"],"grams":200}]}
```

- `expected_items[].match`: the item counts as found if a predicted food's brand, name, or `search_query` contains any of these keywords.
- `expected_items[].grams`: only for weights stated exactly in the input. It's checked within ±10%.
- Optional fields: `expected_intent` (default `log_meal`), `memories`, `expect_inferred`, `expect_clarification`, `expected_local_date`, `now`, and `timezone`. The default clock is fixed at `2026-10-26T12:30:00-07:00` in `America/Los_Angeles`, so date phrases resolve the same way on every run.

## Weighed photo cases: `cases/<id>/`

```
cases/sandy-01-chicken-rice/
  photo.jpg             # gitignored; share on the team drive
  truth.json            # committed
  truth.computed.json   # written by compute-truth.ts; committed
```

`truth.json`:

```json
{
  "items": [
    { "name": "Chicken breast, grilled", "grams": 142, "fdc_id": 171477 },
    { "name": "White rice, cooked", "grams": 186, "fdc_id": 168878, "aliases": ["rice"] },
    { "name": "Olive oil", "grams": 5, "fdc_id": 171413 }
  ],
  "notes": "Oil weighed into the pan",
  "caption": "optional text sent with the photo"
}
```

- Weigh each component before combining. Include the oil, butter, and sauce you actually used; those are what photo models miss.
- Find each `fdc_id` at fdc.nal.usda.gov; the IDs above are only illustrative. Prefer Foundation or SR Legacy entries, and pick the right preparation (cooked or raw).
- Food identification matches on the words in `name`, plus any `aliases`.

## Nutrition lookup

`lib/nutrition-lookup.ts` defines a `NutritionLookup` interface. For now, `UsdaApiLookup` is a simple stand-in: it takes the top USDA search hit and doesn't rank results. Responses are cached in `.cache/usda.json`. When B5's matcher lands, wrap it in a `NutritionLookup` and pass that to `runBakeoff` instead. In `lib/pipeline.ts`, replace `macrosForGrams`/`sumMacros` with `src/lib/nutrition/calc.ts`.
