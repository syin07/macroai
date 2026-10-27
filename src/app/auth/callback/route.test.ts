import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakeSupabase, signedOut, stubSupabaseEnv, type FakeSupabase } from "@/lib/auth/__fixtures__/fake-supabase";

let fake: FakeSupabase;
vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn(() => fake) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: vi.fn() }) }));

const { GET } = await import("./route");

async function callback(query: string) {
  const response = await GET(new NextRequest(`http://localhost:3000/auth/callback${query}`));
  return new URL(response.headers.get("location")!);
}

describe("GET /auth/callback", () => {
  beforeEach(() => {
    stubSupabaseEnv();
    fake = createFakeSupabase(signedOut());
  });

  it("exchanges the code and redirects to a same-origin next path", async () => {
    const to = await callback(`?code=abc&next=${encodeURIComponent("/reset-password?mode=update")}`);
    expect(fake.auth.exchangeCodeForSession).toHaveBeenCalledWith("abc");
    expect(to.origin).toBe("http://localhost:3000");
    expect(to.pathname + to.search).toBe("/reset-password?mode=update");
  });

  it("verifies token_hash email links", async () => {
    const to = await callback("?token_hash=xyz&type=recovery&next=/settings");
    expect(fake.auth.verifyOtp).toHaveBeenCalledWith({ token_hash: "xyz", type: "recovery" });
    expect(to.pathname).toBe("/settings");
  });

  it.each(["https://evil.example/x", "//evil.example/x", "/\\evil.example"])("ignores off-site next %s", async (next) => {
    const to = await callback(`?code=abc&next=${encodeURIComponent(next)}`);
    expect(to.origin).toBe("http://localhost:3000");
    expect(to.pathname).toBe("/chat");
  });

  it("sends failed or missing codes back to sign-in", async () => {
    fake = createFakeSupabase({ ...signedOut(), exchangeError: "invalid flow state" });
    const failed = await callback("?code=bad");
    expect(failed.pathname + failed.search).toBe("/sign-in?error=auth_callback");
    expect((await callback("?error=access_denied")).pathname).toBe("/sign-in");
    expect(fake.auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
  });
});
