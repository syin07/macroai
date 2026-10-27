// The API contract between backend and frontend. Mirrors docs/plans/shared-contracts.md §2.
// Changes need both developers' review and an update to that doc in the same PR.

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

// ---------------------------------------------------------------------------
// Endpoint request / response shapes (shared-contracts §3)
// ---------------------------------------------------------------------------

// POST /api/ai/chat — request is multipart/form-data: client_message_id, text?, image?, timezone
export interface ChatResponse {
  user_message: ChatMessage;
  assistant_message: ChatMessage;     // cards are proposals in confirm mode, saved meals in auto mode
  daily_summary: DailySummary | null; // included whenever a meal was created/changed/deleted
}

// GET /api/messages
export interface MessagesPage {
  messages: ChatMessage[];            // oldest → newest within the page
  has_more: boolean;
}

// POST /api/meals (send an Idempotency-Key header)
export interface SaveMealInput {
  proposal_id: string | null;         // null for manual entries
  name: string;
  consumed_at: string;
  source_type: MealSourceType;
  items: Array<Omit<MealItem, "id">>;
}

export interface SaveMealsRequest {
  meals: SaveMealInput[];
}

export interface SaveMealsResponse {
  meals: Meal[];
  daily_summary: DailySummary;
}

// GET /api/meals
export interface MealsPage {
  meals: MealListItem[];              // newest consumed first
  next_cursor: string | null;
}

// PATCH /api/meals/:id
export interface UpdateMealRequest {
  version: number;
  name?: string;
  consumed_at?: string;
  items?: Array<Omit<MealItem, "id"> & { id: string | null }>;
}

export interface UpdateMealResponse {
  meal: Meal;
  daily_summaries: DailySummary[];    // one per affected day (two if the date moved)
}

// DELETE /api/meals/:id
export interface DeleteMealResponse {
  undo_until: string;
  daily_summary: DailySummary;
}

// POST /api/meals/:id/undo
export interface UndoDeleteResponse {
  meal: Meal;
  daily_summary: DailySummary;
}

// PUT /api/goals
export type PutGoalsRequest = Macros;

// POST /api/goals/suggest
export type Sex = "male" | "female";
export type ActivityLevel = "sedentary" | "light" | "moderate" | "active" | "very_active";
export type WeightGoal = "lose" | "maintain" | "gain";

export interface SuggestGoalsRequest {
  age: number;
  height_cm: number;
  weight_kg: number;
  sex: Sex;
  activity: ActivityLevel;
  goal: WeightGoal;
  target_weight_kg?: number;
}

export interface SuggestGoalsResponse {
  suggested: Macros;
  explanation: string;
}

// PATCH /api/preferences
export type PatchPreferencesRequest = Partial<Preferences>;

// GET /api/memories, PATCH /api/memories/:id
export interface MemoriesResponse {
  memories: Memory[];
}

export interface PatchMemoryRequest {
  content: string;
}

// GET /api/export
export type ExportFormat = "csv" | "json";
export type ExportScope = "nutrition" | "account";

// DELETE /api/account
export interface DeleteAccountRequest {
  confirm: "DELETE";
}
