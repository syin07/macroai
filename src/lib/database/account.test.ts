import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { deleteAccount } from "./account";

const USER_ID = "11111111-1111-4111-8111-111111111111";

const adminWith = (deleteUser: ReturnType<typeof vi.fn>) =>
  ({ auth: { admin: { deleteUser } } }) as unknown as SupabaseClient;

describe("deleteAccount", () => {
  it("hard-deletes the auth user, which cascades to their rows", async () => {
    const deleteUser = vi.fn(async () => ({ data: { user: null }, error: null }));
    await deleteAccount(USER_ID, adminWith(deleteUser));
    // No second argument: shouldSoftDelete stays false, so the row (and the cascade) really goes.
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith(USER_ID);
  });

  it.each(["", "not-a-uuid", "*", "11111111-1111-4111-8111-111111111111' or 1=1"])(
    "refuses a malformed user id %j",
    async (id) => {
      const deleteUser = vi.fn();
      await expect(deleteAccount(id, adminWith(deleteUser))).rejects.toThrow();
      expect(deleteUser).not.toHaveBeenCalled();
    },
  );

  it("throws when the Auth server refuses", async () => {
    const deleteUser = vi.fn(async () => ({ data: null, error: { name: "AuthApiError", message: "User not allowed" } }));
    await expect(deleteAccount(USER_ID, adminWith(deleteUser))).rejects.toThrow(
      "auth user delete failed: AuthApiError: User not allowed",
    );
  });
});
