import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Preferences } from "@/types/api";
import { apiErrorSchema } from "@/lib/validation/errors";
import { preferencesSchema } from "@/lib/validation";
import {
  APPROVED_USER,
  createFakeSupabase,
  signedIn,
  signedOut,
  stubSupabaseEnv,
  type FakeAuthState,
} from "@/lib/auth/__fixtures__/fake-supabase";
import { createAppDb, type MemoryDb } from "@/lib/database/__fixtures__/memory-supabase";

let fake: unknown;
vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn(() => fake) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: vi.fn() }) }));

const { GET, PATCH } = await import("./route");

const ME = APPROVED_USER.id;
const OTHER = "22222222-2222-4222-8222-222222222222";

const MY_PROFILE = { id: ME, display_name: "Sandy", timezone: "America/Los_Angeles", onboarding_complete: false };
const MY_PREFS = { user_id: ME, theme: "dark", save_mode: "confirm", assistant_style: "casual" };
const THEIR_PROFILE = { id: OTHER, display_name: "Ken", timezone: "Asia/Tokyo", onboarding_complete: true };
const THEIR_PREFS = { user_id: OTHER, theme: "light", save_mode: "auto", assistant_style: "detailed" };

let db: MemoryDb;

function given(state: FakeAuthState, tables?: Parameters<typeof createAppDb>[0], fail?: Parameters<typeof createAppDb>[1]) {
  db = createAppDb(
    tables ?? { profiles: [MY_PROFILE, THEIR_PROFILE], account_preferences: [MY_PREFS, THEIR_PREFS] },
    fail,
  );
  fake = { ...createFakeSupabase(state), from: db.from };
}

function patch(body: unknown) {
  return PATCH(
    new Request("http://localhost/api/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const unchangedOther = () => {
  expect(db.rows("profiles").find((row) => row.id === OTHER)).toEqual(THEIR_PROFILE);
  expect(db.rows("account_preferences").find((row) => row.user_id === OTHER)).toEqual(THEIR_PREFS);
};

describe("/api/preferences", () => {
  beforeEach(stubSupabaseEnv);

  it.each([
    ["GET", () => GET()],
    ["PATCH", () => patch({ theme: "light" })],
  ])("%s returns 401 without a session and 403 for an unapproved account", async (_, call) => {
    given(signedOut());
    expect((await call()).status).toBe(401);
    given(signedIn(false));
    const response = await call();
    expect(response.status).toBe(403);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe("not_approved");
    expect(db.from).not.toHaveBeenCalled();
  });

  describe("GET", () => {
    it("maps profiles.timezone and account_preferences into one Preferences", async () => {
      given(signedIn(true));
      const response = await GET();
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const body: Preferences = await response.json();
      expect(preferencesSchema.parse(body)).toEqual({
        theme: "dark",
        save_mode: "confirm",
        timezone: "America/Los_Angeles",
        assistant_style: "casual",
      });
    });

    it("falls back to defaults if the rows are missing", async () => {
      given(signedIn(true), { profiles: [THEIR_PROFILE], account_preferences: [THEIR_PREFS] });
      expect(await (await GET()).json()).toEqual({
        theme: "system",
        save_mode: "confirm",
        timezone: "UTC",
        assistant_style: "casual",
      });
    });

    it("returns 500 internal when a read fails", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      given(signedIn(true), undefined, { table: "account_preferences", op: "select" });
      const response = await GET();
      expect(response.status).toBe(500);
      expect(apiErrorSchema.parse(await response.json()).error.code).toBe("internal");
    });
  });

  describe("PATCH", () => {
    it("writes theme / save_mode / assistant_style to account_preferences only", async () => {
      given(signedIn(true));
      const response = await patch({ theme: "light", save_mode: "auto", assistant_style: "detailed" });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({
        theme: "light",
        save_mode: "auto",
        timezone: "America/Los_Angeles",
        assistant_style: "detailed",
      });
      expect(db.rows("account_preferences").find((row) => row.user_id === ME)).toEqual({
        user_id: ME,
        theme: "light",
        save_mode: "auto",
        assistant_style: "detailed",
      });
      expect(db.rows("profiles").find((row) => row.id === ME)).toEqual(MY_PROFILE);
      unchangedOther();
    });

    it("writes timezone to profiles only", async () => {
      given(signedIn(true));
      const body: Preferences = await (await patch({ timezone: "Europe/London" })).json();
      expect(body).toEqual({ theme: "dark", save_mode: "confirm", timezone: "Europe/London", assistant_style: "casual" });
      expect(db.rows("profiles").find((row) => row.id === ME)).toEqual({ ...MY_PROFILE, timezone: "Europe/London" });
      expect(db.rows("account_preferences").find((row) => row.user_id === ME)).toEqual(MY_PREFS);
      unchangedOther();
    });

    it("splits a mixed patch across both tables", async () => {
      given(signedIn(true));
      const body: Preferences = await (await patch({ timezone: "UTC", save_mode: "auto" })).json();
      expect(body).toEqual({ theme: "dark", save_mode: "auto", timezone: "UTC", assistant_style: "casual" });
      expect(db.rows("profiles").find((row) => row.id === ME)?.timezone).toBe("UTC");
      expect(db.rows("account_preferences").find((row) => row.user_id === ME)?.save_mode).toBe("auto");
      unchangedOther();
    });

    it("rejects unknown time zones and other invalid patches with 400, changing nothing", async () => {
      given(signedIn(true));
      const cases: Array<[unknown, string]> = [
        [{ timezone: "Mars/Olympus_Mons" }, "timezone"],
        [{ timezone: "" }, "timezone"],
        [{ timezone: "PST8PDT; DROP TABLE profiles" }, "timezone"],
        [{ theme: "blue" }, "theme"],
        [{ save_mode: "sometimes" }, "save_mode"],
        [{ user_id: OTHER }, "_"],
        [{}, "_"],
      ];
      for (const [body, field] of cases) {
        const response = await patch(body);
        expect(response.status).toBe(400);
        const error = apiErrorSchema.parse(await response.json()).error;
        expect(error.code).toBe("validation_error");
        expect(error.fields).toHaveProperty(field);
      }
      expect((await patch("nope")).status).toBe(400);
      expect(db.rows("profiles")).toEqual([MY_PROFILE, THEIR_PROFILE]);
      expect(db.rows("account_preferences")).toEqual([MY_PREFS, THEIR_PREFS]);
    });

    it("returns 500 internal if the user's row is missing", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      given(signedIn(true), { profiles: [THEIR_PROFILE], account_preferences: [THEIR_PREFS] });
      expect((await patch({ timezone: "UTC" })).status).toBe(500);
      expect((await patch({ theme: "light" })).status).toBe(500);
      unchangedOther();
    });
  });
});
