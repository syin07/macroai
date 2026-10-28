import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { ApiErrorException } from "@/lib/api-error";
import {
  assertWithinAiCap,
  createAiCapGuard,
  dailyCallCap,
  DEFAULT_AI_DAILY_CALL_CAP,
  isAiCapReached,
  startOfUserDay,
} from "./cap";

const USER_ID = "11111111-1111-4111-8111-111111111111";

// A fake user client holding ai_usage rows. It applies the eq/gte filters the way PostgREST would, so
// the tests check which rows the helper counts, not just which calls it makes.
function fakeClient(rows: Array<{ user_id: string; created_at: string }>, timezone: string | null) {
  const calls: Array<[string, string, unknown]> = [];
  const client = {
    from(table: string) {
      const filters: Array<(row: Record<string, string>) => boolean> = [];
      const chain = {
        select: () => chain,
        eq(column: string, value: string) {
          calls.push([table, `eq.${column}`, value]);
          filters.push((row) => row[column] === value);
          return chain;
        },
        async gte(column: string, value: string) {
          calls.push([table, `gte.${column}`, value]);
          filters.push((row) => new Date(row[column]!).getTime() >= new Date(value).getTime());
          const count = rows.filter((row) => filters.every((f) => f(row))).length;
          return { count, error: null };
        },
        maybeSingle: async () => ({ data: timezone === null ? null : { timezone }, error: null }),
      };
      return chain;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const usage = (count: number, at: string, userId = USER_ID) =>
  Array.from({ length: count }, () => ({ user_id: userId, created_at: at }));

describe("dailyCallCap", () => {
  it.each([
    ["150", 150],
    ["3", 3],
    [undefined, DEFAULT_AI_DAILY_CALL_CAP],
    ["", DEFAULT_AI_DAILY_CALL_CAP],
    ["0", DEFAULT_AI_DAILY_CALL_CAP],
    ["-1", DEFAULT_AI_DAILY_CALL_CAP],
    ["abc", DEFAULT_AI_DAILY_CALL_CAP],
    ["2.5", DEFAULT_AI_DAILY_CALL_CAP],
  ])("AI_DAILY_CALL_CAP=%s → %i", (value, expected) => {
    expect(dailyCallCap(value)).toBe(expected);
  });
});

describe("startOfUserDay", () => {
  it("is local midnight in the user's zone", () => {
    // 2026-10-26 05:30 UTC is still 2026-10-25 22:30 in Los Angeles (PDT, UTC-7).
    expect(startOfUserDay(new Date("2026-10-26T05:30:00Z"), "America/Los_Angeles").toISOString()).toBe(
      "2026-10-25T07:00:00.000Z",
    );
    expect(startOfUserDay(new Date("2026-10-26T05:30:00Z"), "Asia/Tokyo").toISOString()).toBe(
      "2026-10-25T15:00:00.000Z",
    );
  });

  it("handles a DST change day", () => {
    // US DST ends 2026-11-01; local midnight that day is still PDT.
    expect(startOfUserDay(new Date("2026-11-01T20:00:00Z"), "America/Los_Angeles").toISOString()).toBe(
      "2026-11-01T07:00:00.000Z",
    );
  });

  it("falls back to UTC for an unknown zone", () => {
    expect(startOfUserDay(new Date("2026-10-26T05:30:00Z"), "Mars/Olympus").toISOString()).toBe(
      "2026-10-26T00:00:00.000Z",
    );
  });
});

describe("assertWithinAiCap", () => {
  const now = new Date("2026-10-26T18:00:00Z");

  it("passes at cap - 1 and reports usage", async () => {
    const { client } = fakeClient(usage(2, "2026-10-26T10:00:00Z"), "UTC");
    await expect(assertWithinAiCap(client, USER_ID, { now, cap: 3 })).resolves.toEqual({ used: 2, cap: 3 });
  });

  it("throws ai_cap_reached at the cap", async () => {
    const { client } = fakeClient(usage(3, "2026-10-26T10:00:00Z"), "UTC");
    const error = await assertWithinAiCap(client, USER_ID, { now, cap: 3 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiErrorException);
    expect((error as ApiErrorException).code).toBe("ai_cap_reached");
  });

  it("counts only the session user's rows, filtered by user_id", async () => {
    const { client, calls } = fakeClient(
      [...usage(2, "2026-10-26T10:00:00Z"), ...usage(10, "2026-10-26T10:00:00Z", "22222222-2222-4222-8222-222222222222")],
      "UTC",
    );
    await expect(assertWithinAiCap(client, USER_ID, { now, cap: 3 })).resolves.toEqual({ used: 2, cap: 3 });
    expect(calls).toContainEqual(["profiles", "eq.id", USER_ID]);
    expect(calls).toContainEqual(["ai_usage", "eq.user_id", USER_ID]);
  });

  it("counts from local midnight in profiles.timezone, not UTC midnight", async () => {
    // Los Angeles, 2026-10-26 07:30 PDT (14:30 UTC). Today started at 07:00 UTC.
    const laNow = new Date("2026-10-26T14:30:00Z");
    const rows = [
      ...usage(2, "2026-10-26T06:59:59Z"), // 23:59:59 yesterday in LA: not counted
      ...usage(2, "2026-10-26T07:00:00Z"), // local midnight: counted
    ];
    const { client, calls } = fakeClient(rows, "America/Los_Angeles");
    await expect(assertWithinAiCap(client, USER_ID, { now: laNow, cap: 3 })).resolves.toEqual({ used: 2, cap: 3 });
    expect(calls).toContainEqual(["ai_usage", "gte.created_at", "2026-10-26T07:00:00.000Z"]);

    // The same rows in UTC are all "today" (since 00:00 UTC), so the cap is reached.
    const utc = fakeClient(rows, "UTC");
    await expect(assertWithinAiCap(utc.client, USER_ID, { now: laNow, cap: 3 })).rejects.toMatchObject({
      code: "ai_cap_reached",
    });
  });

  it("resets after the user's local midnight", async () => {
    // Tokyo: 3 calls at 23:30 local on the 26th; at 00:10 on the 27th the cap is fresh.
    const rows = usage(3, "2026-10-26T14:30:00Z");
    const before = fakeClient(rows, "Asia/Tokyo");
    await expect(
      assertWithinAiCap(before.client, USER_ID, { now: new Date("2026-10-26T14:50:00Z"), cap: 3 }),
    ).rejects.toMatchObject({ code: "ai_cap_reached" });

    const after = fakeClient(rows, "Asia/Tokyo");
    await expect(
      assertWithinAiCap(after.client, USER_ID, { now: new Date("2026-10-26T15:10:00Z"), cap: 3 }),
    ).resolves.toEqual({ used: 0, cap: 3 });
  });

  it("uses UTC when the profile is missing", async () => {
    const { client, calls } = fakeClient([], null);
    await assertWithinAiCap(client, USER_ID, { now, cap: 3 });
    expect(calls).toContainEqual(["ai_usage", "gte.created_at", "2026-10-26T00:00:00.000Z"]);
  });

  it("reads AI_DAILY_CALL_CAP when no cap is passed", async () => {
    const { client } = fakeClient(usage(DEFAULT_AI_DAILY_CALL_CAP, "2026-10-26T10:00:00Z"), "UTC");
    const original = process.env.AI_DAILY_CALL_CAP;
    delete process.env.AI_DAILY_CALL_CAP;
    try {
      await expect(assertWithinAiCap(client, USER_ID, { now })).rejects.toMatchObject({ code: "ai_cap_reached" });
    } finally {
      if (original !== undefined) process.env.AI_DAILY_CALL_CAP = original;
    }
  });
});

describe("assertWithinAiCap with reserve", () => {
  const now = new Date("2026-10-26T18:00:00Z");

  it("leaves `reserve` calls free: refuses at cap - reserve", async () => {
    const { client } = fakeClient(usage(2, "2026-10-26T10:00:00Z"), "UTC");
    await expect(assertWithinAiCap(client, USER_ID, { now, cap: 3, reserve: 1 })).rejects.toMatchObject({
      code: "ai_cap_reached",
    });
    const { client: fewer } = fakeClient(usage(1, "2026-10-26T10:00:00Z"), "UTC");
    await expect(assertWithinAiCap(fewer, USER_ID, { now, cap: 3, reserve: 1 })).resolves.toEqual({ used: 1, cap: 3 });
  });
});

describe("createAiCapGuard", () => {
  const now = new Date("2026-10-26T18:00:00Z");

  it("re-counts on every check, so calls made during the request count", async () => {
    const rows = usage(1, "2026-10-26T10:00:00Z");
    const { client } = fakeClient(rows, "UTC");
    const guard = createAiCapGuard(client, USER_ID, { now, cap: 3 });
    await expect(guard.check()).resolves.toEqual({ used: 1, cap: 3 });
    rows.push(...usage(1, "2026-10-26T18:00:01Z")); // a call made by this request
    await expect(guard.check()).resolves.toEqual({ used: 2, cap: 3 });
    rows.push(...usage(1, "2026-10-26T18:00:02Z"));
    await expect(guard.check()).rejects.toMatchObject({ code: "ai_cap_reached" });
  });

  it("reads the profile's zone once per guard", async () => {
    const { client, calls } = fakeClient([], "UTC");
    const guard = createAiCapGuard(client, USER_ID, { now, cap: 3 });
    await guard.check();
    await guard.check();
    await guard.check();
    expect(calls.filter(([table]) => table === "profiles")).toHaveLength(1);
    expect(calls.filter(([table, op]) => table === "ai_usage" && op === "eq.user_id")).toHaveLength(3);
  });

  it("takes a per-check reserve", async () => {
    const { client } = fakeClient(usage(2, "2026-10-26T10:00:00Z"), "UTC");
    const guard = createAiCapGuard(client, USER_ID, { now, cap: 3 });
    await expect(guard.check()).resolves.toEqual({ used: 2, cap: 3 });
    await expect(guard.check({ reserve: 1 })).rejects.toMatchObject({ code: "ai_cap_reached" });
  });
});

describe("isAiCapReached", () => {
  it("is true only for the ai_cap_reached ApiErrorException", () => {
    expect(isAiCapReached(new ApiErrorException("ai_cap_reached"))).toBe(true);
    expect(isAiCapReached(new ApiErrorException("ai_unavailable"))).toBe(false);
    expect(isAiCapReached(new Error("ai_cap_reached"))).toBe(false);
  });
});
