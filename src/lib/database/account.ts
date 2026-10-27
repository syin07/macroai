import type { SupabaseClient } from "@supabase/supabase-js";
import { uuid } from "@/lib/validation/common";
import { createServiceRoleClient } from "./admin";

// Account deletion (PRD FR-18, §8 retention). Deleting the auth.users row removes every row the user
// owns in one transaction, through `on delete cascade` foreign keys in 0001_init.sql:
//
//   references auth.users:   profiles, account_preferences, nutrition_goals, meals, conversations,
//                            messages, user_memories, meal_revisions, temporary_uploads, ai_usage,
//                            idempotency_keys
//   through a parent:        meal_items (meals), messages (conversations), meal_revisions (meals)
//   not user data:           nutrition_cache (shared, no user column), approved_emails (allow-list)
//
// supabase/tests/account_deletion.test.sql checks that list against the live schema, so a new user
// table without a cascade fails the test. Using one cascade instead of table-by-table deletes means a
// failure leaves the account whole, never half-deleted. No storage bucket holds user files (photos are
// never stored, FR-15), so there is nothing to remove outside Postgres.

// `userId` must be the session user's id from requireUser(), never a request value. This is the only
// place the service role touches a user-owned row, and only that user's.
export async function deleteAccount(
  userId: string,
  admin: SupabaseClient = createServiceRoleClient(),
): Promise<void> {
  uuid.parse(userId);
  // Hard delete (shouldSoftDelete defaults to false): GoTrue removes the user, their sessions and
  // refresh tokens on every device, and Postgres cascades to the public tables above.
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) throw new Error(`auth user delete failed: ${error.name}: ${error.message}`);
}
