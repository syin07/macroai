import type { SupabaseClient, User } from "@supabase/supabase-js";
import { formatInTimeZone } from "date-fns-tz";
import type { Me } from "@/types/api";
import { isValidTimeZone } from "@/lib/validation/common";

// Profile reads and writes for the signed-in user. Every function takes the RLS-bound client from
// requireUser() and the session user's ID, never an ID from the request.

const ME_COLUMNS = "display_name, onboarding_complete";

interface MeProfileRow {
  display_name: string | null;
  onboarding_complete: boolean;
}

// Callers only reach this after requireUser(), so `approved` is always true.
function toMe(user: User, profile: MeProfileRow | null): Me {
  return {
    user_id: user.id,
    email: user.email ?? "",
    display_name: profile?.display_name ?? null,
    approved: true,
    onboarding_complete: profile?.onboarding_complete ?? false,
  };
}

// GET /api/me. A missing profile row (it's created by the sign-up trigger) reads as defaults.
export async function getMe(supabase: SupabaseClient, user: User): Promise<Me> {
  const { data, error } = await supabase.from("profiles").select(ME_COLUMNS).eq("id", user.id).maybeSingle();
  if (error) throw new Error(`profiles select failed: ${error.message}`);
  return toMe(user, data as MeProfileRow | null);
}

// POST /api/onboarding/complete. Idempotent.
export async function completeOnboarding(supabase: SupabaseClient, user: User): Promise<Me> {
  const { data, error } = await supabase
    .from("profiles")
    .update({ onboarding_complete: true })
    .eq("id", user.id)
    .select(ME_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`profiles update failed: ${error.message}`);
  if (!data) throw new Error("profiles update matched no row");
  return toMe(user, data as MeProfileRow);
}

// The user's IANA time zone; "UTC" if the profile is missing or holds a zone this runtime doesn't know.
export async function getUserTimezone(supabase: SupabaseClient, userId: string): Promise<string> {
  const { data, error } = await supabase.from("profiles").select("timezone").eq("id", userId).maybeSingle();
  if (error) throw new Error(`profiles select failed: ${error.message}`);
  const tz = (data as { timezone: string } | null)?.timezone;
  return tz && isValidTimeZone(tz) ? tz : "UTC";
}

// Calendar date (YYYY-MM-DD) of `now` in `timezone`.
export function localDate(now: Date, timezone: string): string {
  return formatInTimeZone(now, timezone, "yyyy-MM-dd");
}

// Today's date in the user's time zone.
export async function userToday(supabase: SupabaseClient, userId: string, now = new Date()): Promise<string> {
  return localDate(now, await getUserTimezone(supabase, userId));
}
