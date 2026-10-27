import type { SupabaseClient } from "@supabase/supabase-js";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { ApiErrorException } from "@/lib/api-error";
import { isValidTimeZone } from "@/lib/validation/common";

// Per-user daily cap on model calls (PRD §6, §12.15). Every AI route calls assertWithinAiCap() after
// requireUser() and before the first model request.
//
// What counts: one ai_usage row per model call (see usage.ts), so a request that retries after a bad
// model answer uses two. The check runs once per user request, before any call, so a request that
// starts at cap - 1 is allowed to finish its retries and can end one or two calls over the cap; the
// next request is refused. A model call is never cut off halfway through a request.
//
// "Today" is the user's calendar day in profiles.timezone, so the cap resets at their local midnight.

export const DEFAULT_AI_DAILY_CALL_CAP = 150;

// AI_DAILY_CALL_CAP from the environment; a missing or invalid value falls back to the default rather
// than turning the cap off.
export function dailyCallCap(value: string | undefined = process.env.AI_DAILY_CALL_CAP): number {
  const parsed = Number(value);
  return value && Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_AI_DAILY_CALL_CAP;
}

// Start of the user's current local day as an instant. Unknown zones count in UTC.
export function startOfUserDay(now: Date, timezone: string): Date {
  const zone = isValidTimeZone(timezone) ? timezone : "UTC";
  return fromZonedTime(`${formatInTimeZone(now, zone, "yyyy-MM-dd")}T00:00:00`, zone);
}

export interface AiCapStatus {
  used: number;
  cap: number;
}

export interface AiCapOptions {
  now?: Date;
  cap?: number;
}

// Counts today's model calls for the user. `supabase` is the user's own client from requireUser(), so
// RLS limits both reads to their rows; `userId` must be the session user's id.
export async function aiUsageToday(
  supabase: SupabaseClient,
  userId: string,
  { now = new Date(), cap = dailyCallCap() }: AiCapOptions = {},
): Promise<AiCapStatus> {
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("timezone")
    .eq("id", userId)
    .maybeSingle();
  if (profileError) throw new Error(`profiles select failed: ${profileError.message}`);

  const since = startOfUserDay(now, profile?.timezone ?? "UTC");
  const { count, error } = await supabase
    .from("ai_usage")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", since.toISOString());
  if (error) throw new Error(`ai_usage count failed: ${error.message}`);

  return { used: count ?? 0, cap };
}

// Throws ApiErrorException("ai_cap_reached") → 429 once today's calls reach the cap.
export async function assertWithinAiCap(
  supabase: SupabaseClient,
  userId: string,
  options: AiCapOptions = {},
): Promise<AiCapStatus> {
  const status = await aiUsageToday(supabase, userId, options);
  if (status.used >= status.cap) throw new ApiErrorException("ai_cap_reached");
  return status;
}
