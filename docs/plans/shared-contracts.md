# MacroAI — Shared Contracts

The contract between the frontend and the API. The UI calls these endpoints (or mock fixtures with the same shapes); the route handlers return exactly these shapes.

**Source of truth in code:** `src/types/api.ts` (TypeScript types) and `src/lib/validation/` (Zod schemas). This doc mirrors them. If they disagree, fix whichever is wrong in the same PR.

**Changing a contract:** edit `src/types/api.ts`, the matching Zod schema, and this file in the same PR, and update any affected mocks in `src/mocks/` and callers in `src/lib/api/`. Additive changes (a new optional field) are low-risk; renames and removals need every caller updated in that PR.

---

## 1. Code Map

| Path | Area | Notes |
|---|---|---|
| `src/app/api/**` | Backend | All route handlers |
| `src/lib/ai/**`, `src/lib/nutrition/**`, `src/lib/database/**`, `src/lib/memory/**` | Backend | |
| `src/lib/auth/**`, `src/proxy.ts`, `src/app/auth/**` | Backend | The frontend calls the exported helpers. `proxy.ts` is Next 16's name for `middleware.ts`; `src/app/auth/callback` is the OAuth / email-link landing route |
| `src/lib/validation/**`, `src/types/**` | Contract | Keep in sync with this file |
| `src/lib/api-error.ts` | Backend | `ApiError` responses and status codes for routes |
| `supabase/**` | Backend | Migrations, RLS, seed |
| `tests/eval/**` | Backend | Model bake-off and AI eval |
| `src/app/(auth)/**`, `src/app/(app)/**`, `src/app/layout.tsx` | Frontend | All pages and layouts |
| `src/components/**`, `src/hooks/**` | Frontend | |
| `src/lib/api/**` | Frontend | Typed fetch wrappers + mock switch |
| `src/mocks/**` | Frontend | Fixtures matching this file |
| `public/**`, styles, PWA manifest | Frontend | |
| `package.json`, `tsconfig.json`, `.env.example` | Config | Mention new dependencies in the PR description |
| `docs/**` | Docs | Tick plan checkboxes when work merges |

`src/lib/nutrition/calc.ts` is pure (no I/O). The frontend may import it to preview totals while editing; the server always recalculates on save.

---

## 2. Core Types

```ts
// src/types/api.ts

export type NutritionSource = "usda" | "open_food_facts" | "label" | "web" | "ai" | "manual";
export type Confidence = "high" | "medium" | "low";

export interface Macros {
  calories: number;   // kcal
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

export interface MealItem {
  id: string | null;                 // null until saved
  food_name: string;
  quantity: number;
  unit: string;                      // "g", "cup", "slice", "scoop", ...
  grams: number | null;              // normalized weight, if known
  basis_per_100g: Macros | null;     // set when the item came from a database; server derives macros from it
  macros: Macros;                    // this item's contribution
  nutrition_source: NutritionSource;
  source_reference: string | null;   // USDA fdcId, OFF barcode, or URL
  inferred: boolean;                 // hidden ingredient the AI assumed (oil, butter, sauce)
  confidence: Confidence | null;     // null for manual / database-exact items
  edited_by_user: boolean;
  assumptions: string | null;        // shown in expanded card
}

export interface MealProposal {
  proposal_id: string;               // stable ID for an unsaved meal; used as idempotency key on save
  name: string;
  consumed_at: string;               // ISO 8601 with offset
  items: MealItem[];
  totals: Macros;
  needs_clarification: boolean;
  clarification_question: string | null;
}

export type MealSourceType = "text" | "photo" | "barcode" | "manual";

export interface Meal {
  id: string;
  name: string;
  consumed_at: string;
  created_at: string;
  updated_at: string;
  source_type: MealSourceType;
  items: MealItem[];
  totals: Macros;
  status: "active" | "pending_deletion";
  version: number;                   // increments on every update; send it back on PATCH
}

export type MealCard =
  | { kind: "proposal"; state: "unsaved" | "discarded"; proposal: MealProposal }
  | { kind: "meal"; meal_id: string; meal: Meal | null };   // meal is null if it was deleted

export interface ChatMessage {
  id: string;
  client_message_id: string | null;  // echo of the client's ID for user messages
  role: "user" | "assistant";
  text: string;
  cards: MealCard[];
  had_image: boolean;                // the image itself is never stored
  status: "sent" | "pending" | "error";
  created_at: string;
}

export interface MealListItem {
  id: string;
  name: string;
  consumed_at: string;
  totals: Macros;
}

export interface DailySummary {
  date: string;                      // YYYY-MM-DD in the user's time zone
  timezone: string;                  // IANA, e.g. "America/Los_Angeles"
  consumed: Macros;
  targets: Macros | null;            // null if no goals set yet
  remaining: Macros | null;          // may be negative; display as-is
  meals: MealListItem[];             // chronological
}

export interface NutritionGoals extends Macros {
  effective_from: string;            // YYYY-MM-DD
}

export interface Preferences {
  theme: "system" | "light" | "dark";
  save_mode: "confirm" | "auto";
  timezone: string;
  assistant_style: "casual" | "detailed";
}

export interface Memory {
  id: string;
  category: "frequent_food" | "portion" | "brand" | "dietary" | "preparation" | "correction" | "response_style" | "assumption";
  content: string;                   // human-readable, e.g. "Usual shake: Fairlife Core Power 26g, 1 bottle"
  created_at: string;
  updated_at: string;
}

export interface Me {
  user_id: string;
  email: string;
  display_name: string | null;
  approved: boolean;
  onboarding_complete: boolean;
}

export type ErrorCode =
  | "unauthenticated"     // 401 → redirect to sign-in
  | "not_approved"        // 403 → show not-approved page
  | "validation_error"    // 400 → show message; details in `fields`
  | "payload_too_large"   // 413 → image too big
  | "not_found"           // 404
  | "version_conflict"    // 409 → refetch and retry the edit
  | "ai_cap_reached"      // 429 → offer manual logging
  | "ai_unavailable"      // 503 → keep draft, show retry
  | "internal";           // 500

export interface ApiError {
  error: {
    code: ErrorCode;
    message: string;                 // safe to show the user
    retryable: boolean;
    fields?: Record<string, string>;
  };
}
```

---

## 3. Endpoints

Each request/response body below also has a named type in `src/types/api.ts` (`ChatResponse`, `MessagesPage`, `SaveMealsRequest`, `SaveMealsResponse`, `MealsPage`, `UpdateMealRequest`, `UpdateMealResponse`, `DeleteMealResponse`, `UndoDeleteResponse`, `PutGoalsRequest`, `SuggestGoalsRequest`, `SuggestGoalsResponse`, `PatchPreferencesRequest`, `MemoriesResponse`, `PatchMemoryRequest`, `DeleteAccountRequest`) and a matching Zod schema in `src/lib/validation/`. The shapes are identical to the ones written inline here.

All endpoints require a signed-in, approved user (session cookie set by Supabase). Every error response uses `ApiError`. Times are ISO 8601; dates are `YYYY-MM-DD` in the user's time zone.

### Chat (the main entry point)

**`POST /api/ai/chat`** — send a user message (text, photo, or both). The frontend only calls this endpoint for AI; `/api/ai/analyze-meal` is an internal/eval route.

Request: `multipart/form-data`

| Field | Type | Notes |
|---|---|---|
| `client_message_id` | UUID string | Generated by the client; retries with the same ID return the original result instead of re-running the AI |
| `text` | string, optional | Up to 2,000 chars |
| `image` | file, optional | JPEG, longest side ≤ 1024 px, ≤ 1.5 MB (client downscales first) |
| `timezone` | string | IANA zone from the browser |

At least one of `text` / `image` is required.

Response `200`:

```ts
{
  user_message: ChatMessage;
  assistant_message: ChatMessage;     // cards are proposals in confirm mode, saved meals in auto mode
  daily_summary: DailySummary | null; // included whenever a meal was created/changed/deleted
}
```

Not streamed in the MVP; show a loading state. (Streaming is a possible later improvement.)

**`GET /api/messages?before=<message_id>&limit=30`** → `{ messages: ChatMessage[], has_more: boolean }` — newest page first when `before` is omitted; messages within the page are oldest → newest.

**`DELETE /api/messages/:id`** → `204`. Deletes the message only; linked meals are untouched.

### Meals

**`POST /api/meals`** — save one or more meals (from proposals, or manual entries).

Headers: `Idempotency-Key: <uuid>` (use the `proposal_id` for a single proposal; a new UUID for manual entries or save-all).

```ts
// request
{
  meals: Array<{
    proposal_id: string | null;      // null for manual entries
    name: string;
    consumed_at: string;
    source_type: MealSourceType;
    items: Array<Omit<MealItem, "id">>;
  }>;
}
// response 201
{ meals: Meal[]; daily_summary: DailySummary }
```

The server recalculates every item's `macros` from `basis_per_100g × grams / 100` when a basis exists, and keeps client values for `manual`/`ai` items. Totals are always recomputed server-side.

**`GET /api/meals?from=YYYY-MM-DD&to=YYYY-MM-DD&q=<text>&cursor=<opaque>&limit=30`** → `{ meals: MealListItem[], next_cursor: string | null }` — newest consumed first. `q` searches meal and item names.

**`GET /api/meals/:id`** → `Meal`

**`PATCH /api/meals/:id`**

```ts
// request
{ version: number; name?: string; consumed_at?: string; items?: Array<Omit<MealItem, "id"> & { id: string | null }> }
// response 200
{ meal: Meal; daily_summaries: DailySummary[] }   // one per affected day (two if the date moved)
```

Stale `version` → `409 version_conflict`.

**`DELETE /api/meals/:id`** → `{ undo_until: string; daily_summary: DailySummary }` — meal becomes `pending_deletion` and stops counting immediately; permanently deleted after `undo_until` (10 s).

**`POST /api/meals/:id/undo`** → `{ meal: Meal; daily_summary: DailySummary }` — `404` once the window has passed.

### Daily totals

**`GET /api/nutrition/daily?date=YYYY-MM-DD`** → `DailySummary` (defaults to today in the user's time zone).

### Goals, preferences, profile

**`GET /api/me`** → `Me`. Signed out → `401 unauthenticated`; signed in but not on the allow-list → `403 not_approved`, so `approved` is always `true` in a `200`. The not-approved page reads approval from `getSession()` in `src/lib/auth/client.ts` instead.

**`GET /api/goals`** → `NutritionGoals | null`
**`PUT /api/goals`** `{ calories, protein_g, carbs_g, fat_g }` → `NutritionGoals`
**`POST /api/goals/suggest`** `{ age, height_cm, weight_kg, sex: "male" | "female", activity: "sedentary" | "light" | "moderate" | "active" | "very_active", goal: "lose" | "maintain" | "gain", target_weight_kg?: number }` → `{ suggested: Macros, explanation: string }` (does not save)

**`GET /api/preferences`** → `Preferences`
**`PATCH /api/preferences`** `Partial<Preferences>` → `Preferences`

**`POST /api/onboarding/complete`** → `Me`

### Memories

**`GET /api/memories`** → `{ memories: Memory[] }`
**`PATCH /api/memories/:id`** `{ content: string }` → `Memory`
**`DELETE /api/memories/:id`** → `204`

### Export and account

**`GET /api/export?format=csv|json&scope=nutrition|account`** → file download (`Content-Disposition: attachment`). `scope=account` includes chat history and memories (JSON only).

**`DELETE /api/account`** body `{ confirm: "DELETE" }` → `204`, session ends.

---

## 4. Mock Mode

- `NEXT_PUBLIC_USE_MOCKS=1` in `.env.local` makes `src/lib/api/client.ts` return fixtures from `src/mocks/` instead of calling the network, with a 600–1,500 ms fake delay for AI calls.
- Fixtures cover at least: a single-meal proposal, a three-meal proposal, a photo meal with an inferred oil item and a low-confidence item, a clarification question, an auto-saved meal, a deleted-meal card, every `ErrorCode`.
- Every endpoint is now live, so calls use the real API by default; mock mode stays available for UI work and tests, and is ignored in production.

---

## 5. Integration Checkpoints

The points where a backend deliverable lets the matching frontend screen move from mocks to the real API. All of H1–H8 are merged; the remaining (H#) boxes in the plans are end-to-end checks that the frontend really uses them.

| # | Backend delivers | Frontend can then |
|---|---|---|
| H1 | `src/types/api.ts` + Zod schemas merged | Build fixtures and components against real types |
| H2 | Supabase projects, `.env.example`, auth helpers, middleware | Wire real sign-in, sign-out, not-approved page |
| H3 | `GET /api/me`, preferences, goals endpoints | Real settings and onboarding |
| H4 | `POST /api/ai/chat` (text) + `POST /api/meals` + daily endpoint | Real text logging end to end |
| H5 | Photo support in `/api/ai/chat` | Real photo logging |
| H6 | `PATCH`/`DELETE`/undo meals, `GET /api/meals` | Real editor, history, undo toast |
| H7 | `GET /api/messages` pagination | Real chat history scrollback |
| H8 | Memories, export, account deletion | Real settings sections |
