import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiErrorException } from "@/lib/api-error";
import { createFakeQueryClient } from "@/lib/database/__fixtures__/fake-query";
import { exportTables, USER_A, USER_B } from "@/lib/database/__fixtures__/export-rows";
import { apiErrorSchema } from "@/lib/validation/errors";

const requireUser = vi.fn();
vi.mock("@/lib/auth/server", () => ({ requireUser: () => requireUser() }));

// The export must never touch the service role.
const createServiceRoleClient = vi.fn(() => {
  throw new Error("service role must not be used for export");
});
vi.mock("@/lib/database/admin", () => ({ createServiceRoleClient }));

const { GET } = await import("./route");

const get = (query: string) => GET(new Request(`http://localhost/api/export${query}`));

describe("GET /api/export", () => {
  let fake: ReturnType<typeof createFakeQueryClient>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 2026-10-27 03:00 UTC is still the 26th in Los Angeles (user A's zone).
    vi.setSystemTime(new Date("2026-10-27T03:00:00Z"));
    fake = createFakeQueryClient(exportTables());
    requireUser.mockResolvedValue({ user: { id: USER_A, email: "sandy@example.com" }, supabase: fake.client });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    requireUser.mockReset();
  });

  it("returns 401 without a session, before querying anything", async () => {
    requireUser.mockRejectedValue(new ApiErrorException("unauthenticated"));
    const response = await get("?format=json");
    expect(response.status).toBe(401);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe("unauthenticated");
    expect(fake.calls).toEqual([]);
  });

  it("returns 403 for an unapproved account", async () => {
    requireUser.mockRejectedValue(new ApiErrorException("not_approved"));
    expect((await get("?format=csv")).status).toBe(403);
  });

  it.each([
    ["no format", ""],
    ["unknown format", "?format=xml"],
    ["unknown scope", "?format=json&scope=everything"],
  ])("returns 400 for %s", async (_, query) => {
    const response = await get(query);
    expect(response.status).toBe(400);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe("validation_error");
    expect(fake.calls).toEqual([]);
  });

  it("rejects an account export as CSV", async () => {
    const response = await get("?format=csv&scope=account");
    expect(response.status).toBe(400);
    const { error } = apiErrorSchema.parse(await response.json());
    expect(error).toMatchObject({ code: "validation_error", fields: { format: "Account export is JSON only" } });
    expect(fake.calls).toEqual([]);
  });

  it("downloads nutrition CSV with a dated filename in the user's zone", async () => {
    const response = await get("?format=csv");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="macroai-nutrition-2026-10-26.csv"');
    expect(response.headers.get("cache-control")).toBe("private, no-store");

    const text = await response.text();
    const lines = text.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]!.startsWith("meal_id,meal_name,date,consumed_at,")).toBe(true);
    // Breakfast has two items, the quick add has none (one row), the pending_deletion meal is left out.
    expect(lines.filter(Boolean)).toHaveLength(1 + 3);
    expect(text).toContain("'@SUM(1+1)");
    expect(text).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
    expect(text).not.toContain("Deleted snack");
    expect(text).not.toContain("Ken's lunch");
  });

  it("downloads nutrition JSON by default scope", async () => {
    const response = await get("?format=json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="macroai-nutrition-2026-10-26.json"');
    const body = await response.json();
    expect(body).toMatchObject({ scope: "nutrition", timezone: "America/Los_Angeles" });
    expect(body.meals).toHaveLength(2);
    expect(body).not.toHaveProperty("messages");
    expect(body).not.toHaveProperty("memories");
  });

  it("downloads the account JSON with chat history and memories", async () => {
    const response = await get("?format=json&scope=account");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="macroai-account-2026-10-26.json"');
    const text = await response.text();
    const body = JSON.parse(text);
    expect(body.scope).toBe("account");
    expect(body.account.user_id).toBe(USER_A);
    expect(body.messages).toHaveLength(2);
    expect(body.memories).toHaveLength(1);
    expect(text).not.toContain(USER_B);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("returns 500 without logging exported content when a query fails", async () => {
    fake = createFakeQueryClient(exportTables(), { failOn: "messages" });
    requireUser.mockResolvedValue({ user: { id: USER_A, email: "sandy@example.com" }, supabase: fake.client });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await get("?format=json&scope=account");
    expect(response.status).toBe(500);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe("internal");
    expect(log).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(log.mock.calls);
    for (const content of ["a banana", "Breakfast", "banana most mornings"]) expect(logged).not.toContain(content);
  });
});
