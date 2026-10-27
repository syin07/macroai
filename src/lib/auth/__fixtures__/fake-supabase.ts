import { vi } from "vitest";
import { AuthRetryableFetchError, AuthSessionMissingError } from "@supabase/supabase-js";

// A stand-in for the parts of SupabaseClient the auth code touches. Tests mock @supabase/ssr to
// return it, set `state`, and assert on the vi.fn() calls.

export interface FakeAuthState {
  user: { id: string; email: string } | null;
  approved: boolean;
  amr?: Array<{ method: string; timestamp: number }>;
  authUnreachable?: boolean; // getUser()/getClaims() fail with a network error
  rpcError?: string;
  profile?: { display_name: string | null; onboarding_complete: boolean } | null;
  exchangeError?: string;
  onGetClaims?: () => void; // e.g. simulate a token refresh by calling setAll()
}

export const APPROVED_USER = { id: "11111111-1111-4111-8111-111111111111", email: "sandy@example.com" };

export function signedOut(): FakeAuthState {
  return { user: null, approved: false };
}

export function signedIn(approved: boolean, extra: Partial<FakeAuthState> = {}): FakeAuthState {
  return { user: APPROVED_USER, approved, ...extra };
}

export function createFakeSupabase(state: FakeAuthState) {
  const profileQuery = {
    select: vi.fn(() => profileQuery),
    eq: vi.fn(() => profileQuery),
    maybeSingle: vi.fn(async () => ({ data: state.profile ?? null, error: null })),
  };
  const result = <T>(data: T, error: unknown = null) => ({ data, error });

  return {
    auth: {
      getUser: vi.fn(async () => {
        if (state.authUnreachable) return result({ user: null }, new AuthRetryableFetchError("fetch failed", 0));
        return state.user ? result({ user: state.user }) : result({ user: null }, new AuthSessionMissingError());
      }),
      getClaims: vi.fn(async () => {
        state.onGetClaims?.();
        if (!state.user) return result(null, new AuthSessionMissingError());
        return result({ claims: { sub: state.user.id, email: state.user.email, amr: state.amr ?? [] } });
      }),
      exchangeCodeForSession: vi.fn(async () =>
        state.exchangeError ? result(null, new Error(state.exchangeError)) : result({}),
      ),
      verifyOtp: vi.fn(async () => (state.exchangeError ? result(null, new Error(state.exchangeError)) : result({}))),
      signInWithOAuth: vi.fn(async () => result({})),
      signInWithPassword: vi.fn(async () => result({})),
      signUp: vi.fn(async () => result({})),
      resetPasswordForEmail: vi.fn(async () => result({})),
      updateUser: vi.fn(async () => result({})),
      signOut: vi.fn(async () => result(null)),
    },
    rpc: vi.fn(async () => (state.rpcError ? result(null, { message: state.rpcError }) : result(state.approved))),
    from: vi.fn(() => profileQuery),
    profileQuery,
  };
}

export type FakeSupabase = ReturnType<typeof createFakeSupabase>;

export function stubSupabaseEnv() {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
}
