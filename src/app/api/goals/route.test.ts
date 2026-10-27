import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NutritionGoals } from "@/types/api";
import { apiErrorSchema } from "@/lib/validation/errors";
import { nutritionGoalsSchema } from "@/lib/validation";
import {
  APPROVED_USER,
  createFakeSupabase,
  signedIn,
  signedOut,
  stubSupabaseEnv,
  type FakeAuthState,
} from "@/lib/auth/__fixtures__/fake-supabase";
import { createAppDb, type MemoryDb } from "@/lib/database/__fixtures__/memory-supabase";
import { getGoalsOn } from "@/lib/database/goals";
import type { SupabaseClient } from "@supabase/supabase-js";

let fake: unknown;
vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn(() => fake) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: vi.fn() }) }));

const { GET, PUT } = await import("./route");

const ME = APPROVED_USER.id;
const OTHER = "22222222-2222-4222-8222-222222222222";

let db: MemoryDb;

function given(state: FakeAuthState, tables: Parameters<typeof createAppDb>[0] = {}, fail?: Parameters<typeof createAppDb>[1]) {
  db = createAppDb({ profiles: [{ id: ME, timezone: "America/Los_Angeles" }], ...tables }, fail);
  fake = { ...createFakeSupabase(state), from: db.from };
}

function goalRow(userId: string, from: string, to: string | null, calories: number) {
  return {
    id: `${userId}-${from}`,
    user_id: userId,
    calorie_target: calories,
    protein_target_g: 150,
    carbs_target_g: 200,
    fat_target_g: 60,
    effective_from: from,
    effective_to: to,
  };
}

function put(body: unknown) {
  return PUT(
    new Request("http://localhost/api/goals", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const TARGETS = { calories: 2200, protein_g: 160, carbs_g: 230, fat_g: 70 };

// 2026-10-26T05:00Z is still Oct 25 in Los Angeles (UTC-7).
function at(iso: string) {
  vi.setSystemTime(new Date(iso));
}

const myGoals = () =>
  db
    .rows("nutrition_goals")
    .filter((row) => row.user_id === ME)
    .sort((a, b) => String(a.effective_from).localeCompare(String(b.effective_from)));

describe("/api/goals", () => {
  beforeEach(() => {
    stubSupabaseEnv();
    vi.useFakeTimers({ toFake: ["Date"] });
    at("2026-10-26T05:00:00Z");
  });
  afterEach(() => vi.useRealTimers());

  describe("auth", () => {
    it.each([
      ["GET", () => GET()],
      ["PUT", () => put(TARGETS)],
    ])("%s returns 401 without a session and 403 for an unapproved account", async (_, call) => {
      given(signedOut());
      let response = await call();
      expect(response.status).toBe(401);
      expect(apiErrorSchema.parse(await response.json()).error.code).toBe("unauthenticated");

      given(signedIn(false));
      response = await call();
      expect(response.status).toBe(403);
      expect(apiErrorSchema.parse(await response.json()).error.code).toBe("not_approved");
      expect(db.rows("nutrition_goals")).toEqual([]);
      expect(db.from).not.toHaveBeenCalled();
    });
  });

  describe("GET", () => {
    it("returns null when no goals are set", async () => {
      given(signedIn(true), { nutrition_goals: [goalRow(OTHER, "2026-01-01", null, 3000)] });
      const response = await GET();
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toBeNull();
    });

    it("returns the goals in effect today in the user's time zone", async () => {
      given(signedIn(true), {
        nutrition_goals: [
          goalRow(ME, "2026-09-01", "2026-10-01", 1800),
          goalRow(ME, "2026-10-01", "2026-10-26", 2000),
          goalRow(ME, "2026-10-26", null, 2400), // starts tomorrow in Los Angeles
          goalRow(OTHER, "2026-10-20", null, 3000),
        ],
      });
      const body: NutritionGoals = await (await GET()).json();
      expect(nutritionGoalsSchema.parse(body)).toEqual({
        calories: 2000,
        protein_g: 150,
        carbs_g: 200,
        fat_g: 60,
        effective_from: "2026-10-01",
      });
    });

    it("uses the profile's time zone, so a UTC user is already on the next day", async () => {
      given(signedIn(true), {
        profiles: [{ id: ME, timezone: "UTC" }],
        nutrition_goals: [goalRow(ME, "2026-10-01", "2026-10-26", 2000), goalRow(ME, "2026-10-26", null, 2400)],
      });
      const body: NutritionGoals = await (await GET()).json();
      expect(body.calories).toBe(2400);
    });

    it("converts numeric strings from Postgres to numbers", async () => {
      given(signedIn(true), {
        nutrition_goals: [{ ...goalRow(ME, "2026-10-01", null, 0), calorie_target: "2100.000", fat_target_g: "65.500" }],
      });
      const body: NutritionGoals = await (await GET()).json();
      expect(body.calories).toBe(2100);
      expect(body.fat_g).toBe(65.5);
    });

    it("returns 500 internal without details when the query fails", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      given(signedIn(true), {}, { table: "nutrition_goals", op: "select" });
      const response = await GET();
      expect(response.status).toBe(500);
      const body = apiErrorSchema.parse(await response.json());
      expect(body.error.code).toBe("internal");
      expect(JSON.stringify(body)).not.toContain("boom");
    });
  });

  describe("PUT", () => {
    it("rejects invalid bodies with 400 validation_error and saves nothing", async () => {
      given(signedIn(true));
      for (const body of [
        { ...TARGETS, calories: 500 },
        { ...TARGETS, protein_g: -1 },
        { calories: 2000 },
        "not json",
        null,
      ]) {
        const response = await put(body);
        expect(response.status).toBe(400);
        expect(apiErrorSchema.parse(await response.json()).error.code).toBe("validation_error");
      }
      const response = await put({ ...TARGETS, calories: 500 });
      expect(apiErrorSchema.parse(await response.json()).error.fields).toHaveProperty("calories");
      expect(db.rows("nutrition_goals")).toEqual([]);
    });

    it("saves the first goals from today (user's time zone) under the session user", async () => {
      given(signedIn(true));
      const response = await put({ ...TARGETS, user_id: OTHER });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const body: NutritionGoals = await response.json();
      expect(nutritionGoalsSchema.parse(body)).toEqual({ ...TARGETS, effective_from: "2026-10-25" });
      expect(db.rows("nutrition_goals")).toEqual([
        expect.objectContaining({ user_id: ME, effective_from: "2026-10-25", effective_to: null, calorie_target: 2200 }),
      ]);
    });

    it("a change on a later day adds a row and closes the previous one, keeping history", async () => {
      given(signedIn(true), {
        nutrition_goals: [goalRow(ME, "2026-09-01", "2026-10-01", 1800), goalRow(ME, "2026-10-01", null, 2000)],
      });
      await put(TARGETS);

      expect(myGoals()).toEqual([
        expect.objectContaining({ effective_from: "2026-09-01", effective_to: "2026-10-01", calorie_target: 1800 }),
        expect.objectContaining({ effective_from: "2026-10-01", effective_to: "2026-10-25", calorie_target: 2000 }),
        expect.objectContaining({ effective_from: "2026-10-25", effective_to: null, calorie_target: 2200 }),
      ]);
      const client = fake as SupabaseClient;
      expect((await getGoalsOn(client, ME, "2026-10-24"))?.calories).toBe(2000);
      expect((await getGoalsOn(client, ME, "2026-09-15"))?.calories).toBe(1800);
      expect((await getGoalsOn(client, ME, "2026-10-25"))?.calories).toBe(2200);
      expect(await getGoalsOn(client, ME, "2026-08-31")).toBeNull();
      expect(await (await GET()).json()).toEqual({ ...TARGETS, effective_from: "2026-10-25" });
    });

    it("a second change on the same day updates today's row instead of adding one", async () => {
      given(signedIn(true), { nutrition_goals: [goalRow(ME, "2026-10-01", null, 2000)] });
      await put(TARGETS);
      at("2026-10-26T06:30:00Z"); // still Oct 25 in Los Angeles
      const response = await put({ ...TARGETS, calories: 2300 });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ...TARGETS, calories: 2300, effective_from: "2026-10-25" });

      expect(myGoals()).toEqual([
        expect.objectContaining({ effective_from: "2026-10-01", effective_to: "2026-10-25", calorie_target: 2000 }),
        expect.objectContaining({ effective_from: "2026-10-25", effective_to: null, calorie_target: 2300 }),
      ]);
    });

    it("the next day's change closes yesterday's row", async () => {
      given(signedIn(true));
      await put(TARGETS);
      at("2026-10-27T05:00:00Z"); // Oct 26 in Los Angeles
      await put({ ...TARGETS, calories: 1900 });
      expect(myGoals()).toEqual([
        expect.objectContaining({ effective_from: "2026-10-25", effective_to: "2026-10-26", calorie_target: 2200 }),
        expect.objectContaining({ effective_from: "2026-10-26", effective_to: null, calorie_target: 1900 }),
      ]);
    });

    it("replaces rows dated after today (left behind by a move to an earlier time zone)", async () => {
      given(signedIn(true), {
        nutrition_goals: [goalRow(ME, "2026-10-01", "2026-10-26", 2000), goalRow(ME, "2026-10-26", null, 2400)],
      });
      await put(TARGETS);
      expect(myGoals()).toEqual([
        expect.objectContaining({ effective_from: "2026-10-01", effective_to: "2026-10-25", calorie_target: 2000 }),
        expect.objectContaining({ effective_from: "2026-10-25", effective_to: null, calorie_target: 2200 }),
      ]);
    });

    it("never touches another user's goals", async () => {
      const theirs = [goalRow(OTHER, "2026-10-01", null, 3000), goalRow(OTHER, "2026-11-01", null, 3100)];
      given(signedIn(true), { nutrition_goals: theirs });
      await put(TARGETS);
      expect(db.rows("nutrition_goals").filter((row) => row.user_id === OTHER)).toEqual(theirs);
    });

    it("returns 500 internal when the write fails", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      given(signedIn(true), {}, { table: "nutrition_goals", op: "upsert" });
      const response = await put(TARGETS);
      expect(response.status).toBe(500);
      expect(apiErrorSchema.parse(await response.json()).error.code).toBe("internal");
    });
  });
});
