import { AuthApiError } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiErrorException } from "@/lib/api-error";
import { apiErrorSchema } from "@/lib/validation/errors";

const SESSION_USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";

// The user's own client: only signOut is used.
const signOut = vi.fn();
const userClient = { auth: { signOut } };
const requireUser = vi.fn();
vi.mock("@/lib/auth/server", () => ({ requireUser: () => requireUser() }));

// The service-role client: only auth.admin.deleteUser is used.
const deleteUser = vi.fn();
const createServiceRoleClient = vi.fn(() => ({ auth: { admin: { deleteUser } } }));
vi.mock("@/lib/database/admin", () => ({ createServiceRoleClient }));

// Cookie jar for next/headers.
const jar = new Map<string, string>();
const cookieStore = {
  getAll: () => [...jar].map(([name, value]) => ({ name, value })),
  delete: vi.fn((name: string) => jar.delete(name)),
};
vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));

const { DELETE } = await import("./route");

const del = (body: unknown) =>
  DELETE(
    new Request("http://localhost/api/account", {
      method: "DELETE",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

describe("DELETE /api/account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jar.clear();
    jar.set("sb-127-auth-token.0", "chunk0").set("sb-127-auth-token.1", "chunk1").set("theme", "dark");
    requireUser.mockResolvedValue({ user: { id: SESSION_USER }, supabase: userClient });
    deleteUser.mockResolvedValue({ data: { user: null }, error: null });
    signOut.mockResolvedValue({ error: null });
  });
  afterEach(() => vi.restoreAllMocks());

  it("deletes the session user, ends the session and returns 204", async () => {
    const response = await del({ confirm: "DELETE" });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");

    expect(deleteUser).toHaveBeenCalledExactlyOnceWith(SESSION_USER);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(deleteUser.mock.invocationCallOrder[0]).toBeLessThan(signOut.mock.invocationCallOrder[0]!);
    // Supabase cookies are cleared; unrelated cookies are left alone.
    expect([...jar.keys()]).toEqual(["theme"]);
  });

  it("uses the session user id, never one from the body", async () => {
    const response = await del({ confirm: "DELETE", user_id: OTHER_USER, id: OTHER_USER });
    expect(response.status).toBe(204);
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith(SESSION_USER);
    expect(JSON.stringify(deleteUser.mock.calls)).not.toContain(OTHER_USER);
  });

  it.each([
    ["no body", undefined],
    ["a body that isn't JSON", "DELETE"],
    ["an empty object", {}],
    ["lowercase", { confirm: "delete" }],
    ["padded", { confirm: " DELETE " }],
    ["true", { confirm: true }],
    ["the wrong word", { confirm: "yes" }],
  ])("returns 400 for %s and deletes nothing", async (_, body) => {
    const response =
      body === undefined
        ? await DELETE(new Request("http://localhost/api/account", { method: "DELETE" }))
        : await del(body);
    expect(response.status).toBe(400);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe("validation_error");
    expect(deleteUser).not.toHaveBeenCalled();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(jar.size).toBe(3);
  });

  it.each([
    ["unauthenticated", 401],
    ["not_approved", 403],
  ] as const)("returns %s before touching the service role", async (code, status) => {
    requireUser.mockRejectedValue(new ApiErrorException(code));
    const response = await del({ confirm: "DELETE" });
    expect(response.status).toBe(status);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe(code);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("keeps the session and returns 500 when the auth delete fails, so the user can retry", async () => {
    deleteUser.mockResolvedValue({ data: null, error: new AuthApiError("Database error deleting user", 500, "unexpected_failure") });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await del({ confirm: "DELETE" });
    expect(response.status).toBe(500);
    expect(apiErrorSchema.parse(await response.json()).error).toMatchObject({ code: "internal", retryable: true });
    expect(signOut).not.toHaveBeenCalled();
    expect(jar.size).toBe(3);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("still returns 204 and clears cookies when sign-out fails after the user is gone", async () => {
    signOut.mockRejectedValue(new Error("network down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await del({ confirm: "DELETE" });
    expect(response.status).toBe(204);
    expect([...jar.keys()]).toEqual(["theme"]);
  });
});
