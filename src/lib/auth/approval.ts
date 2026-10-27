import type { SupabaseClient } from "@supabase/supabase-js";

// True when the signed-in user's confirmed email is on the allow-list (is_approved() in 0001_init.sql).
export async function isApproved(supabase: SupabaseClient): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_approved");
  if (error) throw new Error(`is_approved() failed: ${error.message}`);
  return data === true;
}
