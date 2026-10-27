import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Service-role client: bypasses RLS. Server-only, and only for writes users may not make themselves
// (nutrition_cache today). Never use it to read or write user-owned rows on a user's behalf; route
// handlers use the session client from requireUser() for that.

let client: SupabaseClient | null = null;

export function createServiceRoleClient(): SupabaseClient {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}
