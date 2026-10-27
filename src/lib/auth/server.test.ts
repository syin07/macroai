import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiErrorException, toErrorResponse } from "@/lib/api-error";
import { createFakeSupabase, signedIn, signedOut, stubSupabaseEnv, type FakeAuthState, type FakeSupabase } from "./__fixtures__/fake-supabase";

let fake: FakeSupabase;
vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn(() => fake) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: vi.fn() }) }));

const { requireUser } = await import("./server");

function given(state: FakeAuthState) {
  fake = createFakeSupabase(state);
}

async function codeOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  return error instanceof ApiErrorException ? error.code : error;
}

describe("requireUser", () => {
  beforeEach(stubSupabaseEnv);

  it("throws unauthenticated without a session", async () => {
    given(signedOut());
    expect(await codeOf(requireUser())).toBe("unauthenticated");
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it("throws not_approved for a signed-in user who isn't on the allow-list", async () => {
    given(signedIn(false));
    expect(await codeOf(requireUser())).toBe("not_approved");
    expect(fake.rpc).toHaveBeenCalledWith("is_approved");
  });

  it("returns the user and the client for an approved user", async () => {
    given(signedIn(true));
    const { user, supabase } = await requireUser();
    expect(user.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(supabase).toBe(fake);
  });

  it("turns an Auth outage or a failed approval check into a 500, not a 401/403", async () => {
    given({ ...signedOut(), authUnreachable: true });
    expect(toErrorResponse(await requireUser().catch((e: unknown) => e)).status).toBe(500);

    given(signedIn(true, { rpcError: "connection refused" }));
    expect(toErrorResponse(await requireUser().catch((e: unknown) => e)).status).toBe(500);
  });
});
