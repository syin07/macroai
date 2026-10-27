# Sandy — Backend & AI Pipeline Plan

**Role:** everything behind the API: Supabase (database, auth, Row Level Security), the AI pipeline, nutrition lookups and math, and all `/api/*` routes.
**Read with:** [`../PRD.md`](../PRD.md) (the what) and [`shared-contracts.md`](shared-contracts.md) (the exact shapes Ken builds against).
**Partner:** Ken owns the frontend. Ken's plan: [`ken-frontend.md`](ken-frontend.md).

Work top to bottom. Tick a box when it's merged to `main`. Steps marked **(H#)** unblock Ken. Post in the team chat when they land.

Ground rules for every step:

- Every route: authenticate → check approved → validate input with Zod → do the work → return contract shapes. Use the server session's user ID, never one sent by the client.
- The model never writes to the database. It returns structured data or tool calls; your code validates and executes.
- All nutrition math lives in `src/lib/nutrition/calc.ts` as pure, unit-tested functions.
- Never log meal text, images, or AI prompts in production logs.

---

## B0 — Contracts first (with Ken)

- [ ] Walk through `shared-contracts.md` together with Ken; change anything either of you dislikes now, while it's cheap.
- [x] Write `src/types/api.ts` exactly as in the contracts doc.
- [x] Write matching Zod schemas in `src/lib/validation/` (`meal.ts`, `chat.ts`, `goals.ts`, `preferences.ts`, `errors.ts`), plus `src/lib/api-error.ts` with a helper that returns `ApiError` responses with the right status codes.
- [x] **(H1)** Merge, and tell Ken.

**Done when:** Ken can import every type, and `tsc` passes.

## B1 — Supabase setup

Can start before Ken's scaffold lands; just create the projects and keys.

- [x] Create two Supabase projects: `macroai-dev` and `macroai-prod`.
- [x] Enable auth providers: email/password (email confirmation on) and Google OAuth (create the OAuth client in Google Cloud Console; redirect URLs for `localhost:3000`, Vercel preview, and production domains).
- [x] Install `@supabase/supabase-js`, `@supabase/ssr`, and the Supabase CLI. Run `supabase init` so migrations live in `supabase/migrations/`.
- [x] Write `.env.example` with: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `APPROVED_EMAILS` (comma-separated), `AI_PROVIDER`, the provider API key, `USDA_API_KEY` (get one at api.data.gov), `AI_DAILY_CALL_CAP` (start at 150), `NEXT_PUBLIC_USE_MOCKS`.
- [ ] Add the same variables to Vercel (Preview → dev project, Production → prod project).

**Done when:** both projects exist, both sign-in methods are enabled, and Vercel has the env vars.

## B2 — Schema, RLS, and approved accounts

- [x] Migration `0001_init.sql`: every table from PRD §7.1 (`profiles`, `account_preferences`, `nutrition_goals`, `meals`, `meal_items` with `basis_per_100g` as jsonb, `nutrition_cache`, `conversations`, `messages`, `user_memories`, `meal_revisions`, `temporary_uploads`, `ai_usage`), plus `approved_emails (email text primary key)` and `idempotency_keys (user_id, key, response jsonb, created_at)`.
- [x] Numeric columns use `numeric(10,3)`; timestamps are `timestamptz`; `meals.version int not null default 1`.
- [x] Trigger: on `auth.users` insert, create `profiles` + `account_preferences` rows (theme `system`, save_mode `confirm`, timezone `UTC` until onboarding).
- [x] SQL function `is_approved()` → true if the current user's email is in `approved_emails`.
- [x] RLS on every user table: `user_id = auth.uid() and is_approved()`. `meal_items` checks ownership through its parent meal. `nutrition_cache` is readable by any approved user and writable only by the service role.
- [x] Indexes from PRD §7.4, plus a trigram index (`pg_trgm`) on `meals.name` and `meal_items.food_name` for search.
- [x] Seed both of your emails into `approved_emails` (dev and prod).
- [x] Write `supabase/tests/rls.sql` (or a TS test using two signed-in clients): user A cannot select, insert, update, or delete user B's rows in any table; an unapproved user can't read anything.

**Done when:** the migration applies cleanly with `supabase db reset`, and the RLS test passes.

## B3 — Auth plumbing

- [x] `src/lib/auth/server.ts`: `createServerClient()` for route handlers / server components, and `requireUser()`, which returns `{ user, supabase }` or throws `unauthenticated` / `not_approved`.
- [x] `src/lib/auth/client.ts`: browser client plus exported helpers for Ken: `signInWithGoogle()`, `signInWithPassword(email, pw)`, `signUp(email, pw)`, `sendPasswordReset(email)`, `updatePassword(pw)`, `signOut()`.
- [x] `src/app/auth/callback/route.ts` for the OAuth / email-link code exchange.
- [x] `src/proxy.ts` (Next 16's rename of `middleware.ts`): refresh the session on every request; redirect signed-out users on `(app)` routes to `/sign-in`; redirect signed-in-but-unapproved users to `/not-approved`.
- [x] `GET /api/me`.
- [ ] **(H2)** Tell Ken the helpers are ready, with a 3-line usage example in the PR description.

**Done when:** you can sign in with Google and with email on localhost, an unapproved test account lands on `/not-approved`, and `GET /api/me` without a session returns `401`.

## B4 — Model bake-off (runs alongside B1–B3)

Goal: pick the AI provider using our own data (PRD §5.4, §16.3).

- [ ] The bake-off uses the text cases plus any ad-hoc photos; there is no weighed-photo test set.
- [x] Add 20+ text cases to `tests/eval/text-cases.jsonl` (`{ input, expected_items }`): simple, multi-item, informal units ("a scoop", "a handful"), three meals in one message, a hypothetical ("should I eat pizza?") that must log nothing.
- [x] Write the extraction prompt v1 (`src/lib/ai/prompts/extract-meal.ts`). It returns the PRD §5.6 schema: foods, grams or units, preparation, `inferred` hidden ingredients, confidence, `search_query`.
- [x] Write the provider interface `src/lib/ai/provider.ts`:
  ```ts
  interface AIProvider {
    extractMeal(input: { text?: string; imageJpeg?: Buffer; now: string; timezone: string; memories: string[] }): Promise<ExtractionResult>;
    chat(input: { system: string; messages: ProviderMessage[]; tools: ToolDef[] }): Promise<ProviderTurn>;
  }
  ```
  Write adapters for the three candidates: Gemini 3.1 Flash-Lite, Claude Haiku 5.5 (`claude-haiku-5-5`), and an affordable OpenAI vision model. Use each one's official SDK and structured-output mode.
- [x] Write the harness `tests/eval/run-bakeoff.ts`: run every case through every adapter → USDA lookup (B5's matcher, or a simple version) → totals. Record per case: calorie error %, protein error (g), food-identification hits, schema validity, latency, and token cost.
- [ ] Write up results in `docs/bakeoff-results.md`: a table per model with median and mean calorie error, protein error, % valid JSON, p50/p90 latency, and $ per 1,000 photos. Pick the winner, and note the runner-up as a fallback.
- [ ] Check the winner's API data policy (no training on inputs; retention period; zero-retention option) and record it in the results doc.
- [ ] Set `AI_PROVIDER` and set the real calorie-error target in PRD §20.

**Done when:** `docs/bakeoff-results.md` is merged with a decision that Ken has seen.

## B5 — Nutrition library

- [x] `src/lib/nutrition/units.ts`: a default-grams table for informal units (cup by food type, tbsp, tsp, slice, scoop, handful, bowl, piece/egg/banana etc.). Fall back to USDA `foodPortions` when available.
- [x] `src/lib/nutrition/usda.ts`: `searchFoods(query)` and `getFood(fdcId)`, normalized to `basis_per_100g` (energy 1008 / 2047 / 2048 → kcal, protein 1003, carbs 1005, fat 1004). Prefer the Foundation and SR Legacy data types for generic foods, and Branded when a brand is named.
- [x] `src/lib/nutrition/match.ts`: rank candidates by name similarity, preparation match (raw vs cooked matters a lot), and data type. Reject below a threshold, and never substitute an unrelated food (PRD FR-04).
- [ ] `src/lib/nutrition/cache.ts`: read and write `nutrition_cache` by normalized query key before calling USDA.
- [x] `src/lib/nutrition/calc.ts` (pure): `itemMacros(basis, grams)`, `sumMacros(items)`, `remaining(consumed, targets)`, `round1()` for display only.
- [x] Unit tests (Vitest): doubling grams doubles macros; meal total = sum of items; rounding happens only at display; unit conversions.
- [ ] Decide **USDA API vs. local copy**: if the API's latency or the 1,000/hour limit hurts in the bake-off, import the Foundation + SR Legacy CSVs into a `usda_foods` table instead. Record the choice in PRD §23.

**Done when:** `matchAndCalculate(extraction)` turns the extraction output into `MealItem[]` with sources, and the tests pass.

## B6 — Meal analysis pipeline (text)

- [ ] `src/lib/ai/analyze.ts`: `analyzeMeal({ text, image?, user })` → `MealProposal[]`. It loads relevant memories, calls `extractMeal`, validates with Zod (retry once on invalid JSON, then fail with `ai_unavailable`), runs B5 matching, falls back to a labeled AI-only estimate (`nutrition_source: "ai"`) per item when there's no match, and computes totals.
- [ ] Resolve dates: the model returns relative phrases or ISO; convert them in code using the user's timezone (`date-fns-tz`). Default to now.
- [ ] Clarification rule (PRD FR-03): if the model's low/high range for an item spans >20% of meal calories or >15 g protein, set `needs_clarification` with one short question.
- [ ] `POST /api/ai/analyze-meal` (internal and eval only).
- [ ] Log usage to `ai_usage` (model, tokens, cost) on every call.

**Done when:** the text eval cases produce valid proposals, and "should I eat pizza?" produces none.

## B7 — Meals API

- [ ] `POST /api/meals` with an `Idempotency-Key` (store the response in `idempotency_keys` and replay it on retry), server-side recalculation, and a `meal_revisions` row with reason `created`.
- [ ] `GET /api/meals` (cursor pagination by `consumed_at, id`; `from`/`to` in the user's time zone; `q` uses the trigram index), and `GET /api/meals/:id`.
- [ ] `PATCH /api/meals/:id`: optimistic concurrency on `version`, recalculation, a revision row, and summaries for both the old and new day if the date moved. Mark changed items `edited_by_user`.
- [ ] `DELETE /api/meals/:id` → `pending_deletion` + `deleted_at`; it is excluded from all totals immediately. `POST /api/meals/:id/undo` within 10 s.
- [ ] A purge job: a Vercel Cron route (`/api/cron/purge`, protected by `CRON_SECRET`) every 5 minutes hard-deletes meals pending for more than 10 s, abandoned `temporary_uploads`, and `idempotency_keys` older than 24 h. (Rows that are pending but past their window are already invisible, so a coarse schedule is fine.)
- [ ] `GET /api/nutrition/daily`: sum of active meals for that local day, plus the goal in effect on that date.
- [ ] Integration tests for: idempotent double save, a stale-version PATCH → 409, a date move updating two days, delete → undo → delete → purge.

**Done when:** the tests pass. **(H4, part)**

## B8 — Chat endpoint with tools

- [ ] `src/lib/ai/tools.ts`: implement the PRD §5.7 tools as plain server functions that take `userId` from the session (never from the model): `search_nutrition_foods`, `get_food_nutrition`, `create_meal_proposal` (wraps B6), `save_meal`, `update_meal`, `delete_meal`, `get_daily_totals`, `search_meal_history`, `get_nutrition_goals`, `search_user_memories`, `save_user_memory`, `delete_user_memory`. Validate each tool's input with Zod.
- [ ] `src/lib/ai/context.ts`: build the context package: system prompt (tone from PRD FR-05, today's date, the user's timezone, save mode), the last 12 messages, today's `DailySummary`, the top relevant memories (keyword match is fine for MVP), and IDs of the last few meals for corrections. Keep it under ~6K tokens.
- [ ] `POST /api/ai/chat`: parse the multipart body, check `client_message_id` for replay, insert the user message (`had_image`, no image bytes), run the tool loop (max 6 steps), apply save mode (`confirm` → return proposal cards; `auto` → call `save_meal` unless `needs_clarification`), insert the assistant message with its cards, and return the contract response.
- [ ] Prompt rules: never claim a save that didn't happen (only say "saved" if `save_meal` returned success); answer account questions only from tool results; never change goals.
- [ ] `GET /api/messages` (cursor by `created_at, id`), `DELETE /api/messages/:id`. When serving messages, re-hydrate `kind: "meal"` cards with current meal data (`null` if deleted).
- [ ] **(H4)** Tell Ken text chat is live.

**Done when:** "2 eggs and toast" → proposal card → save → daily summary updates, through the real UI or `curl`.

## B9 — Photos

- [ ] Accept `image` in `/api/ai/chat`: check the MIME type (JPEG/PNG/WebP), reject over 1.5 MB with `413`, and pass the bytes straight to `extractMeal`. **Never write them to storage or logs** (PRD FR-15 default).
- [ ] Merge the text caption into the same extraction call.
- [ ] Prompt: list likely hidden ingredients (oil, butter, dressing) as `inferred: true` items with `confidence: "low"`. Unrecognizable image → no proposals, and a short explanation.
- [ ] Confirm the deployed function's request-size limit comfortably fits a 1.5 MB upload.
- [ ] **(H5)** Tell Ken photos are live.

**Done when:** a phone photo taken through the real UI produces a card, and nothing image-related exists in the database or storage afterwards.

## B10 — Corrections and dates

- [ ] Context includes the last 5 meals (ID, name, time, items) so the model can target a meal for "remove the cheese" / "I only ate half" / "that was lunch yesterday".
- [ ] `update_meal` tool: if more than one meal plausibly matches, return a clarification instead of guessing (PRD 12.5).
- [ ] Use the meal `version` in the tool to avoid overwriting newer user edits (PRD 12.14).
- [ ] Eval cases for 8 correction phrasings and 6 date phrasings (yesterday, last night, this morning, two hours ago, last Tuesday, at 8 PM). Add them to `tests/eval/`.

**Done when:** all the correction and date eval cases pass.

## B11 — History queries

- [ ] `search_meal_history` tool: date range, food-name search, aggregates (sum or average over recorded days, and how many days had records; PRD 13 says not to treat missing days as zero).
- [ ] Eval cases: "what did I eat last Tuesday", "protein yesterday", "last time I had salmon", "average calories this week".
- [ ] **(H6/H7)** Confirm with Ken that history and message pagination are wired.

## B12 — Goals, preferences, onboarding

- [x] `src/lib/nutrition/goals.ts` (pure): Mifflin–St Jeor BMR, activity multipliers (1.2 / 1.375 / 1.55 / 1.725 / 1.9), goal adjustment (−500 / 0 / +300 kcal), protein 1.8 g/kg (bodyweight), fat 25% of kcal, carbs = remainder. Unit-test against hand calculations.
- [ ] `GET/PUT /api/goals` (a new `effective_from` row on change, so history keeps old targets), `POST /api/goals/suggest`, `GET/PATCH /api/preferences`, `POST /api/onboarding/complete`.
- [ ] **(H3)** Tell Ken.

## B13 — Memory

- [ ] After each chat turn, run a cheap second pass (same provider, small prompt): "Does this exchange contain a reusable preference?" → a `save_user_memory` candidate. Save only if it's explicit ("my usual shake is…") or repeated at least twice (the same correction twice). Deduplicate against existing memories.
- [ ] Retrieval: top 8 memories by keyword overlap with the current message, plus all `response_style` memories.
- [ ] `GET/PATCH/DELETE /api/memories`. Deleted memories are filtered out everywhere.
- [ ] Eval: log "Fairlife Core Power 26g" twice → "my usual shake" resolves to it; delete the memory → it no longer resolves.
- [ ] **(H8, part)**

## B14 — AI cap, export, account deletion

- [ ] AI cap: before any model call, count today's `ai_usage` rows for the user; at `AI_DAILY_CALL_CAP` return `429 ai_cap_reached`.
- [ ] `GET /api/export`: CSV (one row per meal item, with meal columns repeated) and JSON (nested meals → items, plus messages and memories for `scope=account`).
- [ ] `DELETE /api/account`: delete all user rows (cascade), then the auth user via the service role. Verify the other account is untouched.
- [ ] **(H8)** Tell Ken.

## B15 — Security, eval, release

- [ ] Security tests (PRD §16.4): cross-account read/write through every API route with a second session; unapproved account blocked; grep the built client bundle (`.next/static`) for key prefixes; error responses contain no stack traces.
- [ ] Re-run the full eval set on the final prompts; update `docs/bakeoff-results.md`.
- [ ] Apply migrations to `macroai-prod` (`supabase db push`), seed `approved_emails`, set the prod env vars, and add the Vercel Cron.
- [ ] Release checklist with Ken: PRD §19 Definition of Done, line by line.

---

## Later (P1, don't start before the MVP ships)

- Barcode lookups via Open Food Facts (`src/lib/nutrition/off.ts`).
- Web-search lookup fallback using the winning provider's search tool, restricted to trusted domains and cached in `nutrition_cache`.
- Nutrition-label photo extraction.
- Insights aggregates endpoint.
