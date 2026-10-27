import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "@/types/api";
import { apiErrorSchema } from "@/lib/validation/errors";
import { meSchema } from "@/lib/validation";
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

const { POST } = await import("./route");

const ME = APPROVED_USER.id;
const OTHER = "22222222-2222-4222-8222-222222222222";
const MY_PROFILE = { id: ME, display_name: "Sandy", timezone: "UTC", onboarding_complete: false };
const THEIR_PROFILE = { id: OTHER, display_name: "Ken", timezone: "UTC", onboarding_complete: false };

let db: MemoryDb;

function given(state: FakeAuthState, profiles = [MY_PROFILE, THEIR_PROFILE]) {
  db = createAppDb({ profiles });
  fake = { ...createFakeSupabase(state), from: db.from };
}

describe("POST /api/onboarding/complete", () => {
  beforeEach(stubSupabaseEnv);

  it("returns 401 without a session and 403 for an unapproved account, changing nothing", async () => {
    given(signedOut());
    expect((await POST()).status).toBe(401);
    given(signedIn(false));
    const response = await POST();
    expect(response.status).toBe(403);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe("not_approved");
    expect(db.rows("profiles")).toEqual([MY_PROFILE, THEIR_PROFILE]);
  });

  it("marks onboarding complete for the session user and returns Me", async () => {
    given(signedIn(true));
    const response = await POST();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body: Me = await response.json();
    expect(meSchema.parse(body)).toEqual({
      user_id: ME,
      email: "sandy@example.com",
      display_name: "Sandy",
      approved: true,
      onboarding_complete: true,
    });
    expect(db.rows("profiles")).toEqual([{ ...MY_PROFILE, onboarding_complete: true }, THEIR_PROFILE]);
  });

  it("is idempotent", async () => {
    given(signedIn(true), [{ ...MY_PROFILE, onboarding_complete: true }, THEIR_PROFILE]);
    const body: Me = await (await POST()).json();
    expect(body.onboarding_complete).toBe(true);
  });

  it("returns 500 internal if the profile row is missing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    given(signedIn(true), [THEIR_PROFILE]);
    const response = await POST();
    expect(response.status).toBe(500);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe("internal");
    expect(db.rows("profiles")).toEqual([THEIR_PROFILE]);
  });
});
