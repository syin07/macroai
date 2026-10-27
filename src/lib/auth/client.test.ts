import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthApiError } from "@supabase/supabase-js";
import { createFakeSupabase, signedIn, signedOut, stubSupabaseEnv, type FakeAuthState, type FakeSupabase } from "./__fixtures__/fake-supabase";

let fake: FakeSupabase;
vi.mock("@supabase/ssr", () => ({ createBrowserClient: vi.fn(() => fake) }));

const auth = await import("./client");

function given(state: FakeAuthState) {
  fake = createFakeSupabase(state);
}

describe("browser auth helpers", () => {
  beforeEach(() => {
    stubSupabaseEnv();
    vi.stubGlobal("window", { location: { origin: "http://localhost:3000" } });
  });

  it("getSession returns null when signed out", async () => {
    given(signedOut());
    expect(await auth.getSession()).toBeNull();
  });

  it("getSession reports approval and whether the session came from a reset link", async () => {
    given(signedIn(false));
    expect(await auth.getSession()).toEqual({ email: "sandy@example.com", approved: false, recovery: false });

    given(signedIn(true, { amr: [{ method: "recovery", timestamp: 1 }] }));
    expect(await auth.getSession()).toEqual({ email: "sandy@example.com", approved: true, recovery: true });
  });

  it("throws Supabase's AuthError so the UI can map its code", async () => {
    given(signedOut());
    fake.auth.signInWithPassword.mockResolvedValueOnce({
      data: null,
      error: new AuthApiError("Invalid login credentials", 400, "invalid_credentials"),
    } as never);
    await expect(auth.signInWithPassword("a@b.co", "wrong")).rejects.toMatchObject({ code: "invalid_credentials" });
  });

  it("routes email and OAuth links through /auth/callback with the right next path", async () => {
    given(signedOut());
    await auth.sendPasswordReset("a@b.co");
    expect(fake.auth.resetPasswordForEmail).toHaveBeenCalledWith("a@b.co", {
      redirectTo: "http://localhost:3000/auth/callback?next=%2Freset-password%3Fmode%3Dupdate",
    });

    await auth.signUp("a@b.co", "longpassword");
    expect(fake.auth.signUp.mock.calls[0]).toMatchObject([
      { options: { emailRedirectTo: "http://localhost:3000/auth/callback?next=%2Fchat" } },
    ]);

    void auth.signInWithGoogle();
    await vi.waitFor(() => expect(fake.auth.signInWithOAuth).toHaveBeenCalled());
    expect(fake.auth.signInWithOAuth.mock.calls[0]).toMatchObject([
      { provider: "google", options: { redirectTo: "http://localhost:3000/auth/callback?next=%2Fchat" } },
    ]);
  });

  it("updatePassword ends the recovery session after saving", async () => {
    given(signedIn(true));
    await auth.updatePassword("a-new-password");
    expect(fake.auth.updateUser).toHaveBeenCalledWith({ password: "a-new-password" });
    expect(fake.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});
