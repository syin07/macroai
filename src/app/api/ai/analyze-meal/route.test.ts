import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiErrorException } from "@/lib/api-error";
import { ExtractionOutputError, type ExtractionResult } from "@/lib/ai/extraction";
import type { AIProvider } from "@/lib/ai/provider";
import { mealProposalSchema } from "@/lib/validation";
import { apiErrorSchema } from "@/lib/validation/errors";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const MEAL_TEXT = "2 eggs and toast";

// The user's Supabase client: records ai_usage inserts; answers the AI-cap count with `usageToday`;
// user_memories reads return `memoryRows`, recording their filters; nutrition_cache reads miss.
const inserts: Array<[string, unknown]> = [];
const memoryFilters: Array<[string, unknown]> = [];
let usageToday = 0;
let memoryRows: Array<Record<string, string>> = [];
const userClient = {
  from: (table: string) => {
    const chain = {
      insert: async (row: unknown) => (inserts.push([table, row]), { error: null }),
      select: () => chain,
      eq: (column: string, value: unknown) => (table === "user_memories" && memoryFilters.push([column, value]), chain),
      is: (column: string, value: unknown) => (memoryFilters.push([column, value]), chain),
      order: () => chain,
      limit: () => chain,
      overrideTypes: async () => ({ data: memoryRows, error: null }),
      gte: async () => ({ count: usageToday, error: null }),
      maybeSingle: async () => ({ data: table === "profiles" ? { timezone: "UTC" } : null, error: null }),
    };
    return chain;
  },
};

const requireUser = vi.fn();
vi.mock("@/lib/auth/server", () => ({ requireUser: () => requireUser() }));

const extractMeal = vi.fn();
const provider = { name: "anthropic", model: "claude-haiku-5-5", extractMeal, chat: vi.fn() } as unknown as AIProvider;
vi.mock("@/lib/ai/providers", () => ({ getProvider: () => provider }));

vi.mock("@/lib/nutrition/usda", async (original) => ({
  ...(await original<typeof import("@/lib/nutrition/usda")>()),
  searchFoods: vi.fn(async () => []),
  getFood: vi.fn(async () => null),
}));

vi.mock("@/lib/database/admin", () => ({
  createServiceRoleClient: () => {
    throw new Error("not configured");
  },
}));

const { POST } = await import("./route");

const post = (body: unknown) =>
  POST(new Request("http://localhost/api/ai/analyze-meal", { method: "POST", body: JSON.stringify(body) }));

const extraction: ExtractionResult = {
  intent: "log_meal",
  explanation: null,
  meals: [
    {
      name: "Eggs and Toast",
      consumed_at: null,
      time_phrase: "last night",
      needs_clarification: false,
      clarification_question: null,
      foods: [
        {
          name: "Eggs",
          brand: null,
          quantity: 2,
          unit: "egg",
          grams: 100,
          preparation: "boiled",
          estimated_quantity: false,
          inferred: false,
          confidence: "high",
          search_query: "egg, whole, cooked",
          estimated_macros: { calories: 155, protein_g: 12.6, carbs_g: 1.1, fat_g: 10.6 },
          estimate_range: { calories_low: 140, calories_high: 170, protein_g_low: 11, protein_g_high: 14 },
          notes: null,
        },
      ],
    },
  ],
};

describe("POST /api/ai/analyze-meal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inserts.length = 0;
    memoryFilters.length = 0;
    memoryRows = [];
    usageToday = 0;
    vi.stubEnv("AI_DAILY_CALL_CAP", "5");
    requireUser.mockResolvedValue({ user: { id: USER_ID }, supabase: userClient });
    extractMeal.mockResolvedValue({
      result: extraction,
      usage: { inputTokens: 1000, outputTokens: 200 },
      model: "claude-haiku-5-5",
      promptVersion: "extract-meal@v1",
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns 401 without a session, before reading the body or calling the model", async () => {
    requireUser.mockRejectedValue(new ApiErrorException("unauthenticated"));
    const response = await post({ text: MEAL_TEXT, timezone: "UTC" });
    expect(response.status).toBe(401);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe("unauthenticated");
    expect(extractMeal).not.toHaveBeenCalled();
  });

  it("returns 403 for an unapproved account", async () => {
    requireUser.mockRejectedValue(new ApiErrorException("not_approved"));
    expect((await post({ text: MEAL_TEXT, timezone: "UTC" })).status).toBe(403);
  });

  it.each([
    ["missing text", { timezone: "UTC" }],
    ["blank text", { text: "   ", timezone: "UTC" }],
    ["unknown time zone", { text: MEAL_TEXT, timezone: "Mars/Olympus" }],
    ["bad now", { text: MEAL_TEXT, timezone: "UTC", now: "yesterday" }],
  ])("returns 400 for %s", async (_, body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe("validation_error");
  });

  it("returns 400 for a body that isn't JSON", async () => {
    const response = await POST(new Request("http://localhost/api/ai/analyze-meal", { method: "POST", body: "nope" }));
    expect(response.status).toBe(400);
  });

  it("returns proposals and logs usage under the session user", async () => {
    const response = await post({ text: MEAL_TEXT, timezone: "America/Los_Angeles", now: "2026-10-25T21:00:00-07:00" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");

    const body = await response.json();
    expect(body).toMatchObject({ intent: "log_meal", explanation: null, model: "claude-haiku-5-5", promptVersion: "extract-meal@v1" });
    expect(body.proposals).toHaveLength(1);
    const proposal = mealProposalSchema.parse(body.proposals[0]);
    expect(proposal.consumed_at).toBe("2026-10-24T20:00:00-07:00");
    expect(proposal.items[0]!.nutrition_source).toBe("ai"); // USDA mocked to find nothing

    expect(inserts).toEqual([
      ["ai_usage", expect.objectContaining({ user_id: USER_ID, endpoint: "ai/analyze-meal", input_tokens: 1000, output_tokens: 200 })],
    ]);
  });

  it("sends the user's relevant saved memories to the model (B13)", async () => {
    const at = "2026-10-20T08:00:00+00:00";
    memoryRows = [
      { id: "m0000000-0000-4000-8000-000000000001", category: "frequent_food", content: "Usual toast: sourdough, 1 slice", created_at: at, updated_at: at },
      { id: "m0000000-0000-4000-8000-000000000002", category: "brand", content: "Oat milk: Oatly barista", created_at: at, updated_at: at },
      { id: "m0000000-0000-4000-8000-000000000003", category: "response_style", content: "Keep replies short", created_at: at, updated_at: at },
    ];
    expect((await post({ text: MEAL_TEXT, timezone: "UTC" })).status).toBe(200);
    expect(extractMeal.mock.calls[0]![0].memories).toEqual(["Keep replies short", "Usual toast: sourdough, 1 slice"]);
    expect(memoryFilters).toEqual([
      ["user_id", USER_ID],
      ["deleted_at", null],
    ]);
  });

  it("allows the last call under the daily cap", async () => {
    usageToday = 4;
    expect((await post({ text: MEAL_TEXT, timezone: "UTC" })).status).toBe(200);
    expect(extractMeal).toHaveBeenCalledTimes(1);
  });

  it("returns 429 ai_cap_reached at the daily cap, without calling the model", async () => {
    usageToday = 5;
    const response = await post({ text: MEAL_TEXT, timezone: "UTC" });
    expect(response.status).toBe(429);
    expect(apiErrorSchema.parse(await response.json()).error).toMatchObject({ code: "ai_cap_reached", retryable: false });
    expect(extractMeal).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });

  it("returns 503 when the model keeps answering badly, without logging the model's output", async () => {
    const raw = `{"meal": "${MEAL_TEXT}"`;
    extractMeal.mockRejectedValue(new ExtractionOutputError("Model output is not valid JSON", raw, { inputTokens: 1, outputTokens: 1 }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await post({ text: MEAL_TEXT, timezone: "UTC" });
    expect(response.status).toBe(503);
    expect(apiErrorSchema.parse(await response.json()).error).toMatchObject({ code: "ai_unavailable", retryable: true });
    expect(extractMeal).toHaveBeenCalledTimes(2);

    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(MEAL_TEXT);
  });
});
