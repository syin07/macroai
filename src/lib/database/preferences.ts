import type { SupabaseClient } from "@supabase/supabase-js";
import type { PatchPreferencesRequest, Preferences } from "@/types/api";
import { getUserTimezone } from "./profile";

// Preferences span two tables: `timezone` lives in profiles (other server code reads it to work out
// "today"), the rest in account_preferences. Both rows are created by the sign-up trigger and have no
// insert policy, so writes are updates only.

const ACCOUNT_COLUMNS = "theme, save_mode, assistant_style";

type AccountPreferences = Omit<Preferences, "timezone">;

// Matches the column defaults in 0001_init.sql, for a row that's somehow missing on read.
const DEFAULTS: AccountPreferences = { theme: "system", save_mode: "confirm", assistant_style: "casual" };

async function writeTimezone(supabase: SupabaseClient, userId: string, timezone: string): Promise<string> {
  const { data, error } = await supabase
    .from("profiles")
    .update({ timezone })
    .eq("id", userId)
    .select("timezone")
    .maybeSingle();
  if (error) throw new Error(`profiles update failed: ${error.message}`);
  if (!data) throw new Error("profiles update matched no row");
  return (data as { timezone: string }).timezone;
}

async function readAccount(supabase: SupabaseClient, userId: string): Promise<AccountPreferences> {
  const { data, error } = await supabase
    .from("account_preferences")
    .select(ACCOUNT_COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`account_preferences select failed: ${error.message}`);
  return (data as AccountPreferences | null) ?? { ...DEFAULTS };
}

async function writeAccount(
  supabase: SupabaseClient,
  userId: string,
  patch: Partial<AccountPreferences>,
): Promise<AccountPreferences> {
  const { data, error } = await supabase
    .from("account_preferences")
    .update(patch)
    .eq("user_id", userId)
    .select(ACCOUNT_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`account_preferences update failed: ${error.message}`);
  if (!data) throw new Error("account_preferences update matched no row");
  return data as AccountPreferences;
}

function compose(account: AccountPreferences, timezone: string): Preferences {
  return {
    theme: account.theme,
    save_mode: account.save_mode,
    timezone,
    assistant_style: account.assistant_style,
  };
}

export async function getPreferences(supabase: SupabaseClient, userId: string): Promise<Preferences> {
  const [account, timezone] = await Promise.all([
    readAccount(supabase, userId),
    getUserTimezone(supabase, userId),
  ]);
  return compose(account, timezone);
}

// `patch` is already validated (patchPreferencesRequestSchema). Each table is written only if the
// patch touches it, and read otherwise, so the result is the full, saved Preferences.
export async function updatePreferences(
  supabase: SupabaseClient,
  userId: string,
  patch: PatchPreferencesRequest,
): Promise<Preferences> {
  const { timezone, ...rest } = patch;
  const accountPatch = Object.fromEntries(
    Object.entries(rest).filter(([, value]) => value !== undefined),
  ) as Partial<AccountPreferences>;
  const [account, savedTimezone] = await Promise.all([
    Object.keys(accountPatch).length > 0
      ? writeAccount(supabase, userId, accountPatch)
      : readAccount(supabase, userId),
    timezone !== undefined ? writeTimezone(supabase, userId, timezone) : getUserTimezone(supabase, userId),
  ]);
  return compose(account, savedTimezone);
}
