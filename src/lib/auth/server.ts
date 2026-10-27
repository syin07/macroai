import { cookies } from "next/headers";
import { createServerClient as createSupabaseServerClient } from "@supabase/ssr";
import { isAuthRetryableFetchError, type SupabaseClient, type User } from "@supabase/supabase-js";
import { ApiErrorException } from "@/lib/api-error";
import { isApproved } from "./approval";
import { supabaseConfig } from "./config";

// Supabase client for route handlers and server components, acting as the signed-in user
// (anon key + session cookie), so every query goes through RLS.
export async function createServerClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  const { url, anonKey } = supabaseConfig();
  return createSupabaseServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Server components can't set cookies. The proxy refreshes the session on every request,
          // so a token refreshed here is safe to drop.
        }
      },
    },
  });
}

// Every API route starts with this. Throws ApiErrorException("unauthenticated" | "not_approved");
// let the route's catch hand it to toErrorResponse. Use `user.id` as the user ID, never a request value.
export async function requireUser(): Promise<{ user: User; supabase: SupabaseClient }> {
  const supabase = await createServerClient();
  // getUser() asks the Auth server, so revoked sessions and deleted users are rejected.
  const { data, error } = await supabase.auth.getUser();
  if (!data.user) {
    // A network failure reaching Auth is our problem (500, retryable), not a signed-out user.
    if (isAuthRetryableFetchError(error)) throw error;
    throw new ApiErrorException("unauthenticated");
  }
  if (!(await isApproved(supabase))) throw new ApiErrorException("not_approved");
  return { user: data.user, supabase };
}
