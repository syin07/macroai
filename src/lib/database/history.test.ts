import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Macros } from "@/types/api";
import { createFakeDb, fakeClient, type FakeDb } from "./__fixtures__/fake-db";
import { seedMeals, type SeedMeal } from "./__fixtures__/history-seed";
import { DatabaseError } from "./errors";
import { findLastMealMatching, searchMealHistory } from "./history";

// History queries (B11) against the in-memory Supabase from fake-db.ts, which emulates RLS and the
// list_meals SQL function. "Now" is Wednesday 2026-10-28 12:00 in Los Angeles (19:00 UTC).

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const LA = "America/Los_Angeles";
const NOW = new Date("2026-10-28T19:00:00Z");

const m = (calories: number, protein_g: number, carbs_g = 0, fat_g = 0): Macros => ({ calories, protein_g, carbs_g, fat_g });

let db: FakeDb;
const client = (userId = A) => fakeClient(db, { userId });
const seed = (meals: SeedMeal[], userId = A) => seedMeals(db, userId, meals);

beforeEach(() => {
  db = createFakeDb();
  db.profiles.push({ id: A, timezone: LA }, { id: B, timezone: "UTC" });
});

describe("searchMealHistory: meal list", () => {
  it("returns meals in a local-date range, newest first, with their local date", async () => {
    seed([
      { name: "Oatmeal", consumed_at: "2026-10-20T08:00:00-07:00", totals: m(300, 10) },
      { name: "Late pizza", consumed_at: "2026-10-20T23:30:00-07:00", totals: m(800, 30) }, // 06:30 UTC on the 21st
      { name: "Next-day eggs", consumed_at: "2026-10-21T00:30:00-07:00", totals: m(200, 12) },
      { name: "Day before", consumed_at: "2026-10-19T23:59:00-07:00", totals: m(100, 1) },
    ]);
    const result = await searchMealHistory(client(), A, { from: "2026-10-20", to: "2026-10-20" }, NOW);
    expect(result.timezone).toBe(LA);
    expect(result.today).toBe("2026-10-28");
    expect(result.meals.map((meal) => [meal.name, meal.local_date])).toEqual([
      ["Late pizza", "2026-10-20"],
      ["Oatmeal", "2026-10-20"],
    ]);
    expect(result.meals[0]!.totals).toEqual(m(800, 30));
    expect(result.has_more).toBe(false);
    expect(result.aggregate).toBeNull();
  });

  it("uses the user's time zone from the profile, or an explicit one", async () => {
    seed([{ name: "Late pizza", consumed_at: "2026-10-20T23:30:00-07:00", totals: m(800, 30) }]);
    const inTokyo = await searchMealHistory(client(), A, { from: "2026-10-21", to: "2026-10-21", timezone: "Asia/Tokyo" }, NOW);
    expect(inTokyo.meals.map((meal) => meal.local_date)).toEqual(["2026-10-21"]);
    const inLa = await searchMealHistory(client(), A, { from: "2026-10-21", to: "2026-10-21" }, NOW);
    expect(inLa.meals).toEqual([]);
  });

  it("falls back to UTC when the profile is missing", async () => {
    db.profiles = [];
    seed([{ name: "Late pizza", consumed_at: "2026-10-20T23:30:00-07:00", totals: m(800, 30) }]);
    const result = await searchMealHistory(client(), A, { from: "2026-10-21", to: "2026-10-21" }, NOW);
    expect(result.timezone).toBe("UTC");
    expect(result.meals).toHaveLength(1);
  });

  it("excludes pending_deletion meals and other users' meals", async () => {
    seed([
      { name: "Kept", consumed_at: "2026-10-27T12:00:00-07:00", totals: m(500, 20) },
      { name: "Deleted", consumed_at: "2026-10-27T13:00:00-07:00", totals: m(900, 40), status: "pending_deletion", deleted_at: NOW.toISOString() },
    ]);
    seed([{ name: "Someone else", consumed_at: "2026-10-27T14:00:00-07:00", totals: m(700, 30) }], B);
    const result = await searchMealHistory(client(), A, { from: "2026-10-27", to: "2026-10-27", aggregate: true }, NOW);
    expect(result.meals.map((meal) => meal.name)).toEqual(["Kept"]);
    expect(result.aggregate!.sum).toEqual(m(500, 20));
  });

  it("matches q against meal and item names, case-insensitively", async () => {
    seed([
      { name: "Dinner", consumed_at: "2026-10-25T19:00:00-07:00", totals: m(600, 40), items: ["Grilled Salmon", "rice"] },
      { name: "Salmon bagel", consumed_at: "2026-10-26T08:00:00-07:00", totals: m(450, 25) },
      { name: "Lunch", consumed_at: "2026-10-26T12:00:00-07:00", totals: m(500, 30), items: ["chicken"] },
    ]);
    const result = await searchMealHistory(client(), A, { q: " SALMON " }, NOW);
    expect(result.q).toBe("SALMON");
    expect(result.meals.map((meal) => meal.name)).toEqual(["Salmon bagel", "Dinner"]);
  });

  it("applies limit and reports has_more", async () => {
    seed(
      Array.from({ length: 5 }, (_, i) => ({
        name: `Snack ${i}`,
        consumed_at: `2026-10-2${i}T10:00:00-07:00`,
        totals: m(100, 1),
      })),
    );
    const result = await searchMealHistory(client(), A, { limit: 3 }, NOW);
    expect(result.meals.map((meal) => meal.name)).toEqual(["Snack 4", "Snack 3", "Snack 2"]);
    expect(result.has_more).toBe(true);
    expect((await searchMealHistory(client(), A, { limit: 5 }, NOW)).has_more).toBe(false);
  });

  it("validates options", async () => {
    const bad = [
      { from: "2026-10-28", to: "2026-10-27" },
      { from: "2026-02-30" },
      { from: "2026-10-27T00:00:00Z" },
      { limit: 0 },
      { limit: 101 },
      { q: "x".repeat(101) },
      { timezone: "Mars/Olympus" },
    ];
    for (const options of bad) {
      await expect(searchMealHistory(client(), A, options, NOW)).rejects.toBeInstanceOf(z.ZodError);
    }
  });
});

describe("searchMealHistory: aggregate", () => {
  const week: SeedMeal[] = [
    { name: "Mon breakfast", consumed_at: "2026-10-19T08:00:00-07:00", totals: m(400, 30, 40, 10) },
    { name: "Mon dinner", consumed_at: "2026-10-19T19:00:00-07:00", totals: m(1600, 90, 160, 60) },
    { name: "Wed lunch", consumed_at: "2026-10-21T12:00:00-07:00", totals: m(1500, 100, 150, 50) },
    { name: "Sun brunch", consumed_at: "2026-10-25T11:00:00-07:00", totals: m(2200, 110, 230, 80) },
  ];

  it("returns per-day totals and averages over recorded days only", async () => {
    seed(week);
    const result = await searchMealHistory(client(), A, { from: "2026-10-19", to: "2026-10-25", aggregate: true }, NOW);
    const agg = result.aggregate!;
    expect(agg.days).toEqual([
      { date: "2026-10-19", meal_count: 2, totals: m(2000, 120, 200, 70) },
      { date: "2026-10-21", meal_count: 1, totals: m(1500, 100, 150, 50) },
      { date: "2026-10-25", meal_count: 1, totals: m(2200, 110, 230, 80) },
    ]);
    expect(agg.days_in_range).toBe(7);
    expect(agg.days_with_records).toBe(3);
    expect(agg.missing_dates).toEqual(["2026-10-20", "2026-10-22", "2026-10-23", "2026-10-24"]);
    expect(agg.sum).toEqual(m(5700, 330, 580, 200));
    const average = agg.average_per_recorded_day!;
    expect(average.calories).toBeCloseTo(1900, 9); // 5700 / 3 recorded days, not / 7
    expect(average.protein_g).toBeCloseTo(110, 9);
    expect(average.carbs_g).toBeCloseTo(580 / 3, 9);
    expect(average.fat_g).toBeCloseTo(200 / 3, 9);
    expect(agg.includes_today).toBe(false);
    expect(agg.to_clamped_to_today).toBe(false);
  });

  it("covers every meal in range even when q narrows the list", async () => {
    seed(week);
    const result = await searchMealHistory(client(), A, { from: "2026-10-19", to: "2026-10-25", q: "brunch", aggregate: true }, NOW);
    expect(result.meals.map((meal) => meal.name)).toEqual(["Sun brunch"]);
    expect(result.aggregate!.sum.calories).toBe(5700);
  });

  it("is not capped by the meal list limit", async () => {
    seed(week);
    const result = await searchMealHistory(client(), A, { from: "2026-10-19", to: "2026-10-25", limit: 1, aggregate: true }, NOW);
    expect(result.meals).toHaveLength(1);
    expect(result.aggregate!.days_with_records).toBe(3);
  });

  it("clamps `to` to today, and defaults it to today", async () => {
    seed([
      { name: "Mon", consumed_at: "2026-10-26T12:00:00-07:00", totals: m(1800, 100) },
      { name: "Today so far", consumed_at: "2026-10-28T08:00:00-07:00", totals: m(400, 20) },
    ]);
    for (const options of [{ from: "2026-10-26", to: "2026-11-01" }, { from: "2026-10-26" }]) {
      const result = await searchMealHistory(client(), A, { ...options, aggregate: true }, NOW);
      expect(result.to).toBe("2026-10-28");
      expect(result.aggregate!.days_in_range).toBe(3);
      expect(result.aggregate!.missing_dates).toEqual(["2026-10-27"]);
      expect(result.aggregate!.includes_today).toBe(true);
      expect(result.aggregate!.to_clamped_to_today).toBe(true);
      expect(result.aggregate!.average_per_recorded_day!.calories).toBe(1100);
    }
  });

  it("a range with no records has no average", async () => {
    const result = await searchMealHistory(client(), A, { from: "2026-10-27", to: "2026-10-27", aggregate: true }, NOW);
    expect(result.aggregate!.days_with_records).toBe(0);
    expect(result.aggregate!.sum).toEqual(m(0, 0));
    expect(result.aggregate!.average_per_recorded_day).toBeNull();
  });

  it("assigns meals to local days across a DST change and a month end", async () => {
    // US DST ends 2026-11-01 in Los Angeles; that local day runs 07:00Z to 08:00Z the next day.
    seed([
      { name: "Halloween late snack", consumed_at: "2026-10-31T23:30:00-07:00", totals: m(300, 5) },
      { name: "Nov 1 late dinner", consumed_at: "2026-11-01T23:30:00-08:00", totals: m(900, 50) }, // 07:30Z Nov 2
      { name: "Nov 2 breakfast", consumed_at: "2026-11-02T07:00:00-08:00", totals: m(350, 20) },
    ]);
    const now = new Date("2026-11-03T20:00:00Z");
    const result = await searchMealHistory(client(), A, { from: "2026-10-30", to: "2026-11-02", aggregate: true }, now);
    expect(result.aggregate!.days.map((d) => [d.date, d.totals.calories])).toEqual([
      ["2026-10-31", 300],
      ["2026-11-01", 900],
      ["2026-11-02", 350],
    ]);
    expect(result.aggregate!.missing_dates).toEqual(["2026-10-30"]);
  });

  it("reads long ranges in windows without double-counting the edges", async () => {
    // One meal at 00:00 and one at 23:59 local on every day of a 100-day range.
    const meals: SeedMeal[] = [];
    for (let i = 0; i < 100; i++) {
      const date = new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10);
      meals.push({ name: "midnight", consumed_at: `${date}T00:00:00Z`, totals: m(100, 1) });
      meals.push({ name: "late", consumed_at: `${date}T23:59:59Z`, totals: m(10, 1) });
    }
    seed(meals);
    const result = await searchMealHistory(
      client(),
      A,
      { from: "2026-07-01", to: "2026-10-08", aggregate: true, timezone: "UTC" },
      NOW,
    );
    expect(result.aggregate!.days_in_range).toBe(100);
    expect(result.aggregate!.days_with_records).toBe(100);
    expect(result.aggregate!.days.every((d) => d.meal_count === 2)).toBe(true);
    expect(result.aggregate!.sum).toEqual(m(11000, 200));
  });

  it("refuses rather than undercounts when a window hits the PostgREST row cap", async () => {
    seed(Array.from({ length: 1000 }, () => ({ name: "crumb", consumed_at: "2026-10-27T12:00:00-07:00", totals: m(1, 0) })));
    await expect(
      searchMealHistory(client(), A, { from: "2026-10-27", to: "2026-10-27", aggregate: true }, NOW),
    ).rejects.toBeInstanceOf(DatabaseError);
  });

  it("requires from, a range starting by today, and at most 366 days", async () => {
    await expect(searchMealHistory(client(), A, { aggregate: true }, NOW)).rejects.toBeInstanceOf(z.ZodError);
    await expect(searchMealHistory(client(), A, { from: "2026-10-29", aggregate: true }, NOW)).rejects.toBeInstanceOf(z.ZodError);
    await expect(searchMealHistory(client(), A, { from: "2025-10-26", to: "2026-10-27", aggregate: true }, NOW)).rejects.toBeInstanceOf(z.ZodError);
    const ok = await searchMealHistory(client(), A, { from: "2025-10-28", to: "2026-10-28", aggregate: true }, NOW);
    expect(ok.aggregate!.days_in_range).toBe(366);
  });
});

describe("findLastMealMatching", () => {
  it("returns the most recent matching meal with its items", async () => {
    seed([
      { name: "Sushi", consumed_at: "2026-10-10T19:00:00-07:00", totals: m(700, 40), items: ["salmon nigiri", "rice"] },
      { name: "Dinner", consumed_at: "2026-10-24T19:30:00-07:00", totals: m(650, 45), items: ["Baked Salmon", "broccoli"] },
      { name: "Lunch", consumed_at: "2026-10-27T12:00:00-07:00", totals: m(500, 30), items: ["chicken"] },
    ]);
    const hit = await findLastMealMatching(client(), A, { q: "salmon" }, NOW);
    expect(hit).not.toBeNull();
    expect(hit!.meal.name).toBe("Dinner");
    expect(hit!.meal.items.map((item) => item.food_name)).toEqual(["Baked Salmon", "broccoli"]);
    expect(hit!.local_date).toBe("2026-10-24");
    expect(hit!.days_ago).toBe(4);
    expect(hit!.matched_items).toEqual(["Baked Salmon"]);
  });

  it("matches on the meal name too (matched_items may be empty)", async () => {
    seed([{ name: "Salmon poke", consumed_at: "2026-10-28T09:00:00-07:00", totals: m(550, 35), items: ["tuna", "rice"] }]);
    const hit = await findLastMealMatching(client(), A, { q: "salmon" }, NOW);
    expect(hit!.days_ago).toBe(0);
    expect(hit!.matched_items).toEqual([]);
  });

  it("respects `before`, skips pending deletions and other users, and returns null when nothing matches", async () => {
    seed([
      { name: "Old salmon", consumed_at: "2026-10-01T19:00:00-07:00", totals: m(600, 40) },
      { name: "Recent salmon", consumed_at: "2026-10-20T19:00:00-07:00", totals: m(600, 40) },
      { name: "Deleted salmon", consumed_at: "2026-10-27T19:00:00-07:00", totals: m(600, 40), status: "pending_deletion", deleted_at: NOW.toISOString() },
    ]);
    seed([{ name: "B's salmon", consumed_at: "2026-10-28T09:00:00Z", totals: m(1, 1) }], B);
    expect((await findLastMealMatching(client(), A, { q: "salmon" }, NOW))!.meal.name).toBe("Recent salmon");
    expect((await findLastMealMatching(client(), A, { q: "salmon", before: "2026-10-19" }, NOW))!.meal.name).toBe("Old salmon");
    expect(await findLastMealMatching(client(), A, { q: "salmon", before: "2026-09-30" }, NOW)).toBeNull();
    expect(await findLastMealMatching(client(), A, { q: "durian" }, NOW)).toBeNull();
  });

  it("requires a non-empty q", async () => {
    await expect(findLastMealMatching(client(), A, { q: "  " }, NOW)).rejects.toBeInstanceOf(z.ZodError);
  });
});
