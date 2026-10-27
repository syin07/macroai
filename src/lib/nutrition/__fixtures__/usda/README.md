# USDA FoodData Central fixtures

Recorded 2026-10-26 from `https://api.nal.usda.gov/fdc/v1` with `DEMO_KEY`, using the same requests `usda.ts` sends:

- `search-*.json`: `POST /foods/search` with `{ query, dataType, pageSize: 25 }`. Generic searches use `["Foundation", "SR Legacy", "Survey (FNDDS)"]`; the Core Power search uses `["Branded"]`.
- `food-<fdcId>-*.json`: `GET /food/<fdcId>`. `fixture-client.ts` serves these by ID.

| File | Query / FDC ID |
|---|---|
| `search-chicken-breast-grilled.json` | `chicken breast grilled` |
| `search-rice-white-cooked.json` | `rice white cooked` |
| `search-banana.json` | `banana` |
| `search-fairlife-core-power.json` | `fairlife core power protein shake` (Branded) |
| `food-171534-chicken-breast-grilled.json` | SR Legacy, portions in `modifier` |
| `food-168930-rice-white-cooked.json` | SR Legacy, one `cup` portion |
| `food-173944-banana-raw.json` | SR Legacy, size portions (small … extra large) |
| `food-2705968-chicken-breast-fndds.json` | FNDDS, portions in `portionDescription` |
| `food-1935189-core-power.json` | Branded, serving in ml |

The raw responses were about 0.5 MB each, so they were trimmed before committing. Each food keeps the fields `usda.ts` reads, plus `foodCategory`. Nutrients are cut down to IDs 1003, 1004, 1005, 1008, 1050, 1062 (kJ, kept to show it's ignored), 2047, and 2048. Values are otherwise unchanged. Response order is preserved, because the matcher uses it to break ties.

To re-record, repeat the requests above with your own `USDA_API_KEY` in an `X-Api-Key` header, then apply the same trimming. Tests never call the live API.
