# AI eval and model bake-off

Plan step B4; PRD §5.4 and §16.3. Run everything from the repo root. Keys are read from `.env.local` or the environment.

```bash
npx tsx tests/eval/compute-truth.ts                    # USDA truth for photo cases (USDA_API_KEY)
npx tsx tests/eval/run-bakeoff.ts                      # all cases × gemini, anthropic, openai
npx tsx tests/eval/run-bakeoff.ts --providers anthropic --only text --case t09-three-meals
npx tsx tests/eval/run-bakeoff.ts --only text --max-usd 0.10      # hard spend cap (default $0.25)
```

The runner refuses any model without a price in `src/lib/ai/pricing.ts`, and stops as soon as billed tokens reach `--max-usd`. A full text run (25 cases) costs about 2¢ for Haiku, 3¢ for Gemini, and 11¢ for `gpt-5.4-mini`.

Output goes to `results/<timestamp>/` (gitignored): `results.jsonl` has one record per case × provider, and `summary.md` has the tables for `docs/bakeoff-results.md`.

## Text cases: `text-cases.jsonl`

One JSON object per line. The schema is `textCaseSchema` in `lib/cases.ts`.

```json
{"id":"t03-explicit-grams","category":"explicit_weight","input":"150g grilled chicken breast and 200g cooked white rice","expected_meals":1,"expected_items":[{"match":["chicken"],"grams":150},{"match":["rice"],"grams":200}]}
```

- `expected_items[].match`: the item counts as found if a predicted food's brand, name, or `search_query` contains any of these keywords.
- `expected_items[].grams`: only for weights stated exactly in the input. It's checked within ±10%.
- Optional fields: `expected_intent` (default `log_meal`), `memories`, `expect_inferred`, `expect_clarification`, `expected_local_date`, `now`, and `timezone`. The default clock is fixed at `2026-10-26T12:30:00-07:00` in `America/Los_Angeles`, so date phrases resolve the same way on every run.

## Weighed photo cases: `cases/<id>/` (optional)

We decided not to build a weighed-photo test set. The format below still works for any ad-hoc photos you weigh.

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

`lib/nutrition-lookup.ts` defines a `NutritionLookup` interface. The bake-off uses `MatcherLookup`, which wraps B5's matcher (`src/lib/nutrition/match.ts`), so foods are ranked and rejected exactly as in production; responses are cached in `.cache/usda-matcher.json`. `compute-truth.ts` still uses the simpler `UsdaApiLookup`, since it only fetches foods by exact FDC ID. Totals use `src/lib/nutrition/calc.ts`.

## History cases: `history-cases.jsonl` (B11)

Deterministic checks for history questions: no model and no API calls. `lib/history-cases.test.ts` runs every case in `npm test`. For each case it seeds the fixture meals into the in-memory Supabase (`src/lib/database/__fixtures__/fake-db.ts`, which emulates RLS and `list_meals`), makes the call that B8's `search_meal_history` tool would make, and checks the numbers. Date phrases are already resolved in `call.args`. Turning "last Tuesday" into a date is B10's job, and its eval cases cover it.

One JSON object per line (shortened here; the schema is `historyCaseSchema` in `lib/history-cases.test.ts`):

```json
{"id":"h05-missing-days-not-zero","question":"what's my average protein over the last 7 days?","now":"2026-10-28T21:00:00-07:00","timezone":"America/Los_Angeles",
 "meals":[{"name":"Thu","consumed_at":"2026-10-22T12:00:00-07:00","totals":{"calories":2000,"protein_g":140,"carbs_g":200,"fat_g":70}},
          {"name":"Sun deleted","consumed_at":"2026-10-25T12:00:00-07:00","totals":{"calories":900,"protein_g":50,"carbs_g":90,"fat_g":30},"status":"pending_deletion"}],
 "call":{"fn":"searchMealHistory","args":{"from":"2026-10-22","to":"2026-10-28","aggregate":true}},
 "expect":{"days_in_range":7,"days_with_records":4,"missing_dates":["2026-10-23","2026-10-25","2026-10-26"],"average_per_recorded_day":{"protein_g":120}}}
```

- `now` and `timezone` set the user's clock and zone. Local days follow `timezone`.
- `meals[]`: saved meals for the one test user. `totals` are stored exactly as given. `items` are food names (each item gets an equal share of the totals) and default to the meal name. `status: "pending_deletion"` meals must never show up in a result.
- `call.fn` is `searchMealHistory` (args: `from`, `to`, `q`, `limit`, `aggregate`) or `findLastMealMatching` (args: `q`, `before`). Dates are local `YYYY-MM-DD` and inclusive.
- `expect` holds only the fields you want checked. Macro numbers must match within ±0.001, so averages may be written to 3 decimals. The fields are:
  - `meal_names`: newest first.
  - `to`: the range end after clamping to today.
  - `days_in_range`, `days_with_records`, `missing_dates`, `includes_today`.
  - `sum` and `average_per_recorded_day`: partial macros, or `null` for "no recorded days".
  - `last_match`: `meal_name`, `local_date`, `days_ago`, `matched_items`, `totals`, or `null`.
- PRD §13: averages divide by recorded days only, and a missing day is never counted as zero. Every case set must keep at least one case with `missing_dates`.
