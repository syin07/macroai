import type { SupabaseClient } from "@supabase/supabase-js";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { ApiErrorException } from "@/lib/api-error";
import { isValidTimeZone } from "@/lib/validation/common";

// Per-user daily cap on model calls (PRD §6, §12.15).
//
// What counts: one ai_usage row per model call (see usage.ts), including retries after a bad model
// answer. The cap is checked before every model call, not once per request:
//   - each AI route checks once up front (assertWithinAiCap → 429 before anything is stored);
//   - within a chat turn, a guard from createAiCapGuard() is checked before each chat step and each
//     extraction attempt, so a turn can't run past the cap. A turn that hits it midway keeps what it
//     already did (a proposal, a saved meal) and ends with a short "daily AI limit" reply (chat.ts);
//   - the background memory pass checks with reserve: 1, so it never takes the day's last call.
// A model call already in flight is never cut off. Two requests running at the same moment can both
// see the same last free call, so the cap can be passed by at most one call per concurrent request.
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
  // Calls to leave free: the check fails once used + reserve >= cap. The memory pass uses 1.
  reserve?: number;
}

// The start of the user's local day, from their profile's zone (UTC when unset). `supabase` is the
// user's own client from requireUser(), so RLS limits reads to their rows.
async function userDayStart(supabase: SupabaseClient, userId: string, now: Date): Promise<Date> {
  const { data: profile, error } = await supabase.from("profiles").select("timezone").eq("id", userId).maybeSingle();
  if (error) throw new Error(`profiles select failed: ${error.message}`);
  return startOfUserDay(now, profile?.timezone ?? "UTC");
}

async function countUsageSince(supabase: SupabaseClient, userId: string, since: Date): Promise<number> {
  const { count, error } = await supabase
    .from("ai_usage")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", since.toISOString());
  if (error) throw new Error(`ai_usage count failed: ${error.message}`);
  return count ?? 0;
}

// Counts today's model calls for the user. `userId` must be the session user's id.
export async function aiUsageToday(
  supabase: SupabaseClient,
  userId: string,
  { now = new Date(), cap = dailyCallCap() }: AiCapOptions = {},
): Promise<AiCapStatus> {
  const since = await userDayStart(supabase, userId, now);
  return { used: await countUsageSince(supabase, userId, since), cap };
}

export interface AiCapGuard {
  // Throws ApiErrorException("ai_cap_reached") when no call (beyond `reserve`) is left today. Call it
  // right before each model call. It re-counts ai_usage, so calls this request already made count.
  check(options?: { reserve?: number }): Promise<AiCapStatus>;
}

// One guard per request: the start of the user's day is read once, then each check is one count query.
export function createAiCapGuard(
  supabase: SupabaseClient,
  userId: string,
  { now = new Date(), cap = dailyCallCap(), reserve: defaultReserve = 0 }: AiCapOptions = {},
): AiCapGuard {
  let since: Promise<Date> | undefined;
  return {
    async check({ reserve = defaultReserve } = {}) {
      since ??= userDayStart(supabase, userId, now).catch((error: unknown) => {
        since = undefined; // a failed read isn't remembered
        throw error;
      });
      const used = await countUsageSince(supabase, userId, await since);
      if (used + reserve >= cap) throw new ApiErrorException("ai_cap_reached");
      return { used, cap };
    },
  };
}

// Throws ApiErrorException("ai_cap_reached") → 429 once today's calls reach the cap (less `reserve`).
export async function assertWithinAiCap(
  supabase: SupabaseClient,
  userId: string,
  options: AiCapOptions = {},
): Promise<AiCapStatus> {
  return createAiCapGuard(supabase, userId, options).check();
}

export function isAiCapReached(error: unknown): boolean {
  return error instanceof ApiErrorException && error.code === "ai_cap_reached";
}
