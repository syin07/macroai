import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SuggestGoalsRequest } from "@/types/api";
import { apiErrorSchema } from "@/lib/validation/errors";
import { suggestGoalsResponseSchema } from "@/lib/validation";
import {
  createFakeSupabase,
  signedIn,
  signedOut,
  stubSupabaseEnv,
  type FakeAuthState,
  type FakeSupabase,
} from "@/lib/auth/__fixtures__/fake-supabase";
import { suggestGoals } from "@/lib/nutrition/goals";

let fake: FakeSupabase;
vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn(() => fake) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: vi.fn() }) }));

const { POST } = await import("./route");

function given(state: FakeAuthState) {
  fake = createFakeSupabase(state);
}

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/goals/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const INPUT: SuggestGoalsRequest = {
  age: 30,
  height_cm: 180,
  weight_kg: 80,
  sex: "male",
  activity: "moderate",
  goal: "lose",
};

describe("POST /api/goals/suggest", () => {
  beforeEach(stubSupabaseEnv);

  it("returns 401 without a session and 403 for an unapproved account", async () => {
    given(signedOut());
    expect((await post(INPUT)).status).toBe(401);
    given(signedIn(false));
    const response = await post(INPUT);
    expect(response.status).toBe(403);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe("not_approved");
  });

  it("returns suggestGoals() for valid input and saves nothing", async () => {
    given(signedIn(true));
    const response = await post(INPUT);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = suggestGoalsResponseSchema.parse(await response.json());
    expect(body).toEqual(suggestGoals(INPUT));
    // Hand check: BMR 10*80 + 6.25*180 - 5*30 + 5 = 1780; ×1.55 = 2759; −500 → 2259 kcal.
    expect(body.suggested.calories).toBe(2259);
    expect(fake.from).not.toHaveBeenCalled();
  });

  it("accepts the optional target weight", async () => {
    given(signedIn(true));
    const response = await post({ ...INPUT, target_weight_kg: 75 });
    expect(response.status).toBe(200);
  });

  it("rejects invalid input with 400 validation_error and per-field messages", async () => {
    given(signedIn(true));
    const cases: Array<[unknown, string]> = [
      [{ ...INPUT, age: 5 }, "age"],
      [{ ...INPUT, sex: "other" }, "sex"],
      [{ ...INPUT, activity: "extreme" }, "activity"],
      [{ ...INPUT, weight_kg: "80" }, "weight_kg"],
      [{ ...INPUT, goal: undefined }, "goal"],
    ];
    for (const [body, field] of cases) {
      const response = await post(body);
      expect(response.status).toBe(400);
      const error = apiErrorSchema.parse(await response.json()).error;
      expect(error.code).toBe("validation_error");
      expect(error.fields).toHaveProperty(field);
    }
    expect((await post("{")).status).toBe(400);
  });
});
