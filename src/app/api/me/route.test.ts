import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "@/types/api";
import { apiErrorSchema } from "@/lib/validation/errors";
import {
  createFakeSupabase,
  signedIn,
  signedOut,
  stubSupabaseEnv,
  type FakeAuthState,
  type FakeSupabase,
} from "@/lib/auth/__fixtures__/fake-supabase";

let fake: FakeSupabase;
vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn(() => fake) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: vi.fn() }) }));

const { GET } = await import("./route");

function given(state: FakeAuthState) {
  fake = createFakeSupabase(state);
}

describe("GET /api/me", () => {
  beforeEach(stubSupabaseEnv);

  it("returns 401 unauthenticated without a session", async () => {
    given(signedOut());
    const response = await GET();
    expect(response.status).toBe(401);
    const body = apiErrorSchema.parse(await response.json());
    expect(body.error.code).toBe("unauthenticated");
  });

  it("returns 403 not_approved for an unapproved account", async () => {
    given(signedIn(false));
    const response = await GET();
    expect(response.status).toBe(403);
    const body = apiErrorSchema.parse(await response.json());
    expect(body.error.code).toBe("not_approved");
  });

  it("returns Me for an approved account, reading the profile by the session user ID", async () => {
    given(signedIn(true, { profile: { display_name: "Sandy", onboarding_complete: true } }));
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body: Me = await response.json();
    expect(body).toEqual({
      user_id: "11111111-1111-4111-8111-111111111111",
      email: "sandy@example.com",
      display_name: "Sandy",
      approved: true,
      onboarding_complete: true,
    });
    expect(fake.from).toHaveBeenCalledWith("profiles");
    expect(fake.profileQuery.eq).toHaveBeenCalledWith("id", "11111111-1111-4111-8111-111111111111");
  });

  it("defaults display_name and onboarding when the profile row is missing", async () => {
    given(signedIn(true, { profile: null }));
    const body: Me = await (await GET()).json();
    expect(body.display_name).toBeNull();
    expect(body.onboarding_complete).toBe(false);
  });
});
