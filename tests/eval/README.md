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

## Date cases: `date-cases.jsonl`

Plan step B10; PRD FR-09. These need no model and no keys: `lib/date-cases.test.ts` runs every line through `resolveConsumedAt()` (`src/lib/ai/dates.ts`) as part of `npm test`. The model's only job for dates is copying the user's words into `time_phrase`; code turns them into a timestamp. The schema is `dateCaseSchema` in `lib/cases.ts`.

```json
{"id":"d31-at-8pm-before-8pm","phrase":"at_clock_time","input":"at 8 PM","now":"2026-10-26T12:30:00-07:00","timezone":"America/Los_Angeles","expected_local":"2026-10-25T20:00","note":"Today's 8 PM is hours away: the most recent one, yesterday"}
```

- `phrase`: which of the six FR-09 phrasings the case exercises: `yesterday`, `last_night`, `this_morning`, `hours_ago`, `last_weekday`, or `at_clock_time`. The test requires at least 3 cases of each.
- `input`: the time words as they would appear in `time_phrase`.
- `now` and `timezone`: required on every line, since the edge cases (just after midnight, DST, other zones) depend on them.
- `expected_local`: the resolved `consumed_at` as wall-clock time in `timezone`, `YYYY-MM-DDTHH:mm`. The test also checks that it is never later than `now`.
- `note`: optional; say why when the answer isn't obvious.

The rules for ambiguous phrasings ("last Tuesday" said on a Tuesday, "at 8 PM" said before 8 PM, a bare "around 8", DST gaps) are in the comment at the top of `dates.ts`.

## Correction cases: `correction-cases.jsonl`

Plan step B10; PRD FR-06, §12.5, §12.14. The schema is `correctionCaseSchema` in `lib/cases.ts`.

```bash
npm test                                                     # CI: scripted model, no keys, no cost
npx tsx tests/eval/run-corrections.ts --provider anthropic --max-usd 0.05   # opt-in: a real model (paid)
```

Both runners use the harness in `lib/corrections.ts`. It seeds the case's meals into the in-memory Supabase (`src/lib/database/__fixtures__/fake-db.ts`) for one test user, then runs the message through the real chat turn: `buildContext()` with the recent meals, `runChatTurn()`, the real tools, and `createMealStore()` on B7's meal writes. Afterwards `checkCorrection()` compares the saved meals with `expected`. Only the model differs:

- `lib/correction-cases.test.ts` (in `npm test`) checks that each case is well-formed, then drives it with a scripted model. `SCRIPTED_CALLS` holds the call a good model would make. Its meal ID and version are read from the context block, so the run also checks that B10's context lists them. It also checks that the checker catches wrong outcomes (a guess, the wrong item or time, the wrong meal).
- `run-corrections.ts` uses a real provider, behind the same kind of `--max-usd` hard cap as the bake-off (default $0.05). It refuses unpriced models. Food lookups use the harness's fixed list (skim milk), so it needs no USDA key.

Each line is one correction message, the state it applies to, and the expected outcome:

```json
{"id":"c01-remove-the-cheese","input":"remove the cheese",
 "recent_meals":[{"id":"m-sandwich","name":"Turkey sandwich","consumed_at":"2026-10-26T12:10:00-07:00","version":1,
   "items":[{"id":"i-cheddar","name":"Cheddar cheese","quantity":1,"unit":"slice","grams":28,"macros":{"calories":113,"protein_g":7,"carbs_g":0.4,"fat_g":9.3}}, "..."]}, "..."],
 "expected":{"kind":"update","tool":"update_meal","meal_id":"m-sandwich","version":1,"removed_items":["i-cheddar"],"totals":{"calories":"down"}}}
```

(Shown wrapped; in the file each case is one line.)

- `now` and `timezone`: optional, with the same defaults as text cases.
- `recent_messages`: optional earlier chat turns, oldest first, for corrections that refer back ("I only ate half").
- `recent_meals`: the fixture, newest first, at most 5 (what B10's context shows). The runner seeds these into a fake store for a test user. IDs are readable labels; the runner maps them to UUIDs.
- `expected` is one of:
  - `{"kind":"update","tool":"update_meal","meal_id","version", ...effects}`: exactly one `update_meal` call on that meal, sending the `version` from the fixture (PRD 12.14). Effects describe the meal after the call, so the case doesn't depend on the tool's argument shape:
    - `removed_items`: these item IDs are gone.
    - `scale_all`: every item's grams are multiplied by this (±5%).
    - `item_grams` / `item_quantity`: `{item_id: value}` after the change (grams ±5%).
    - `item_renamed`: `{item_id: [keywords]}`: the item's new name contains one of the keywords (a food swap, re-matched for nutrition).
    - `consumed_local_date` / `consumed_local_hours` (`[from, to)`): where `consumed_at` lands in the case's zone. `time_phrase` is what the resolver should get; the test checks it agrees with `date-cases` rules.
    - `totals.calories`: `down`, `up`, or `same` versus the fixture.
    - Anything not listed must be unchanged: other items, other meals, and `consumed_at` unless a date effect is given.
  - `{"kind":"delete","tool":"delete_meal","meal_id"}`: exactly one `delete_meal` call on that meal.
  - `{"kind":"clarification","candidate_meal_ids":[...]}`: no meal is changed or deleted, and the reply asks which meal (PRD 12.5). The listed meals are the plausible targets. An `update_meal` call without `meal_id` is allowed: the tool writes nothing and returns `needs_clarification`, and its `candidates` must be exactly these meals.

The 8 cases: remove the cheese, I only ate half, that was lunch yesterday, make it 2 eggs not 3, it was 200g not 150g, actually that was skim milk, delete that last meal, and "remove the cheese" when two meals today have cheese (needs a clarification).

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

Deterministic checks for history questions: no model and no API calls. `lib/history-cases.test.ts` runs every case in `npm test`. For each case it seeds the fixture meals into the in-memory Supabase (`src/lib/database/__fixtures__/fake-db.ts`, which emulates RLS and `list_meals`), makes the call that B8's `search_meal_history` tool would make, and checks the numbers. It then runs the same case through the tool itself (`runTool` with `createMealStore`), with macros checked to within 0.5 because the tool rounds for display. Date phrases are already resolved in `call.args`. Turning "last Tuesday" into a date is B10's job, and its eval cases cover it.

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
