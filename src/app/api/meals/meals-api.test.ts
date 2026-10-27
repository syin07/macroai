import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { MealItem, SaveMealInput } from "@/types/api";
import { ApiErrorException } from "@/lib/api-error";
import { createFakeDb, fakeClient, type FakeDb } from "@/lib/database/__fixtures__/fake-db";
import { dailySummarySchema, mealSchema, mealsPageSchema } from "@/lib/validation";
import { apiErrorSchema } from "@/lib/validation/errors";

// Route tests for B7: /api/meals, /api/meals/:id, /api/meals/:id/undo, /api/nutrition/daily and
// /api/cron/purge, against an in-memory Supabase (src/lib/database/__fixtures__/fake-db.ts) that
// emulates RLS and the 0002 SQL functions. The SQL itself is covered by supabase/tests/meals_api.test.sql.

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

let db: FakeDb;
let session: string | null;

vi.mock("@/lib/auth/server", () => ({
  requireUser: async () => {
    if (!session) throw new ApiErrorException("unauthenticated");
    return { user: { id: session }, supabase: fakeClient(db, { userId: session }) };
  },
}));
vi.mock("@/lib/database/admin", () => ({ createServiceRoleClient: () => fakeClient(db, "service_role") }));

const mealsRoute = await import("./route");
const mealRoute = await import("./[id]/route");
const undoRoute = await import("./[id]/undo/route");
const dailyRoute = await import("../nutrition/daily/route");
const purgeRoute = await import("../cron/purge/route");

// --- Contract shapes ---------------------------------------------------------

const saveResponseSchema = z.strictObject({ meals: z.array(mealSchema), daily_summary: dailySummarySchema });
const updateResponseSchema = z.strictObject({ meal: mealSchema, daily_summaries: z.array(dailySummarySchema) });
const deleteResponseSchema = z.strictObject({ undo_until: z.iso.datetime({ offset: true }), daily_summary: dailySummarySchema });
const undoResponseSchema = z.strictObject({ meal: mealSchema, daily_summary: dailySummarySchema });

async function errorCode(response: Response) {
  return apiErrorSchema.parse(await response.json()).error.code;
}

// --- Request helpers ---------------------------------------------------------

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function save(body: unknown, key: string | null = randomUUID()) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers["Idempotency-Key"] = key;
  return mealsRoute.POST(new Request("http://localhost/api/meals", { method: "POST", headers, body: JSON.stringify(body) }));
}
const list = (query = "") => mealsRoute.GET(new Request(`http://localhost/api/meals${query}`));
const getMeal = (id: string) => mealRoute.GET(new Request(`http://localhost/api/meals/${id}`), ctx(id));
const patch = (id: string, body: unknown) =>
  mealRoute.PATCH(new Request(`http://localhost/api/meals/${id}`, { method: "PATCH", body: JSON.stringify(body) }), ctx(id));
const remove = (id: string) => mealRoute.DELETE(new Request(`http://localhost/api/meals/${id}`, { method: "DELETE" }), ctx(id));
const undo = (id: string) => undoRoute.POST(new Request(`http://localhost/api/meals/${id}/undo`, { method: "POST" }), ctx(id));
const daily = (query = "") => dailyRoute.GET(new Request(`http://localhost/api/nutrition/daily${query}`));
const purge = (authorization?: string) =>
  purgeRoute.GET(new Request("http://localhost/api/cron/purge", { headers: authorization ? { authorization } : {} }));

// --- Fixtures ----------------------------------------------------------------

type ItemInput = Omit<MealItem, "id">;

// 150 g grilled chicken from USDA: macros must come from the basis (165 kcal/100 g → 247.5 kcal).
const chicken = (overrides: Partial<ItemInput> = {}): ItemInput => ({
  food_name: "grilled chicken breast",
  quantity: 150,
  unit: "g",
  grams: 150,
  basis_per_100g: { calories: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6 },
  macros: { calories: 247.5, protein_g: 46.5, carbs_g: 0, fat_g: 5.4 },
  nutrition_source: "usda",
  source_reference: "171534",
  inferred: false,
  confidence: null,
  edited_by_user: false,
  assumptions: null,
  ...overrides,
});

// An AI estimate with no basis: its macros are kept as sent.
const oil = (overrides: Partial<ItemInput> = {}): ItemInput => ({
  food_name: "olive oil",
  quantity: 1,
  unit: "tbsp",
  grams: null,
  basis_per_100g: null,
  macros: { calories: 119.333, protein_g: 0, carbs_g: 0, fat_g: 13.5 },
  nutrition_source: "ai",
  source_reference: null,
  inferred: true,
  confidence: "low",
  edited_by_user: false,
  assumptions: "cooking oil",
  ...overrides,
});

const meal = (overrides: Partial<SaveMealInput> = {}): SaveMealInput => ({
  proposal_id: null,
  name: "Chicken lunch",
  consumed_at: "2026-10-26T12:30:00-07:00",
  source_type: "text",
  items: [chicken(), oil()],
  ...overrides,
});

async function saveOne(input: Partial<SaveMealInput> = {}) {
  const response = await save({ meals: [meal(input)] });
  expect(response.status).toBe(201);
  return saveResponseSchema.parse(await response.json()).meals[0]!;
}

// "Now" is 2026-10-26 12:00 in Los Angeles (19:00 UTC).
const NOW = new Date("2026-10-26T19:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
  db = createFakeDb();
  db.profiles.push({ id: A, timezone: "America/Los_Angeles" }, { id: B, timezone: "Europe/London" });
  db.nutrition_goals.push(
    { user_id: A, calorie_target: 2000, protein_target_g: 150, carbs_target_g: 200, fat_target_g: 60, effective_from: "2026-01-01", effective_to: null },
    { user_id: A, calorie_target: 1800, protein_target_g: 160, carbs_target_g: 150, fat_target_g: 55, effective_from: "2026-10-27", effective_to: null },
  );
  session = A;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// -----------------------------------------------------------------------------

describe("auth and input checks", () => {
  it("answers 401 on every route without a session", async () => {
    session = null;
    const id = randomUUID();
    for (const response of await Promise.all([
      save({ meals: [meal()] }),
      list(),
      getMeal(id),
      patch(id, { version: 1, name: "x" }),
      remove(id),
      undo(id),
      daily(),
    ])) {
      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe("unauthenticated");
    }
  });

  it("requires a UUID Idempotency-Key on POST /api/meals", async () => {
    for (const key of [null, "not-a-uuid"]) {
      const response = await save({ meals: [meal()] }, key);
      expect(response.status).toBe(400);
      const body = apiErrorSchema.parse(await response.json());
      expect(body.error.fields).toHaveProperty("Idempotency-Key");
    }
    expect(db.meals).toHaveLength(0);
  });

  it("rejects invalid bodies with field errors", async () => {
    const response = await save({ meals: [meal({ items: [] })] });
    expect(response.status).toBe(400);
    expect(apiErrorSchema.parse(await response.json()).error.fields).toHaveProperty(["meals.0.items"]);

    const notJson = await mealsRoute.POST(
      new Request("http://localhost/api/meals", { method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: "{" }),
    );
    expect(notJson.status).toBe(400);
  });

  it("treats malformed meal ids as not found", async () => {
    expect((await getMeal("nope")).status).toBe(404);
    expect((await patch("nope", { version: 1, name: "x" })).status).toBe(404);
    expect((await remove("nope")).status).toBe(404);
    expect((await undo("nope")).status).toBe(404);
  });
});

describe("POST /api/meals", () => {
  it("saves meals as the session user, with a created revision and today's summary", async () => {
    const response = await save({ meals: [{ ...meal(), user_id: B }] }); // a smuggled user_id is ignored
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = saveResponseSchema.parse(await response.json());

    const [saved] = body.meals;
    expect(saved).toMatchObject({ name: "Chicken lunch", status: "active", version: 1, source_type: "text" });
    expect(saved!.items.map((item) => item.food_name)).toEqual(["grilled chicken breast", "olive oil"]);
    expect(saved!.items.every((item) => item.id !== null)).toBe(true);
    expect(db.meals[0]!.user_id).toBe(A);
    expect(db.meal_revisions).toMatchObject([{ meal_id: saved!.id, user_id: A, reason: "created", previous_values: null }]);

    expect(body.daily_summary).toEqual({
      date: "2026-10-26",
      timezone: "America/Los_Angeles",
      consumed: { calories: 366.833, protein_g: 46.5, carbs_g: 0, fat_g: 18.9 },
      targets: { calories: 2000, protein_g: 150, carbs_g: 200, fat_g: 60 },
      remaining: { calories: 2000 - 366.833, protein_g: 103.5, carbs_g: 200, fat_g: 60 - 18.9 },
      meals: [{ id: saved!.id, name: "Chicken lunch", consumed_at: saved!.consumed_at, totals: saved!.totals }],
    });
  });

  it("recalculates macros from the basis and ignores tampered client macros", async () => {
    const tampered = chicken({ macros: { calories: 1, protein_g: 999, carbs_g: 0, fat_g: 0 } });
    const saved = await saveOne({ items: [tampered, oil()] });

    expect(saved.items[0]!.macros).toEqual({ calories: 247.5, protein_g: 46.5, carbs_g: 0, fat_g: 5.4 });
    expect(saved.items[1]!.macros).toEqual(oil().macros); // no basis: client value kept
    expect(saved.totals).toEqual({ calories: 366.833, protein_g: 46.5, carbs_g: 0, fat_g: 18.9 });
    expect(db.meal_items[0]).toMatchObject({ calories: 247.5, protein_g: 46.5 });
    expect(db.meals[0]).toMatchObject({ total_calories: 366.833, total_protein_g: 46.5 });
  });

  it("does not round stored values", async () => {
    // 1.09 protein/100 g × 118 g = 1.2862 g (stored at numeric(10,3) precision, not rounded to 1 decimal)
    const banana = chicken({
      food_name: "banana",
      grams: 118,
      quantity: 1,
      unit: "medium",
      basis_per_100g: { calories: 89, protein_g: 1.09, carbs_g: 22.84, fat_g: 0.33 },
    });
    const saved = await saveOne({ items: [banana] });
    expect(saved.items[0]!.macros).toEqual({ calories: 105.02, protein_g: 1.286, carbs_g: 26.951, fat_g: 0.389 });
  });

  it("rejects an item whose derived macros are absurd", async () => {
    const huge = chicken({ grams: 10_000, quantity: 10_000, basis_per_100g: { calories: 50_000, protein_g: 0, carbs_g: 0, fat_g: 0 } });
    const response = await save({ meals: [meal({ items: [oil(), huge] })] });
    expect(response.status).toBe(400);
    expect(apiErrorSchema.parse(await response.json()).error.fields).toEqual({ "meals.0.items.1.grams": "That amount is too large." });
    expect(db.meals).toHaveLength(0);
  });

  it("is idempotent: a retry with the same key replays the first save and writes nothing", async () => {
    const key = randomUUID();
    const first = await save({ meals: [meal()] }, key);
    const second = await save({ meals: [meal()] }, key);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.headers.get("idempotency-replayed")).toBeNull();
    expect(second.headers.get("idempotency-replayed")).toBe("true");
    const a = saveResponseSchema.parse(await first.json());
    const b = saveResponseSchema.parse(await second.json());
    expect(b.meals.map((m) => m.id)).toEqual(a.meals.map((m) => m.id));
    expect(b.daily_summary.consumed).toEqual(a.daily_summary.consumed);

    expect(db.meals).toHaveLength(1);
    expect(db.meal_items).toHaveLength(2);
    expect(db.meal_revisions).toHaveLength(1);
    expect(db.idempotency_keys).toEqual([expect.objectContaining({ user_id: A, key, response: { meal_ids: [a.meals[0]!.id] } })]);
  });

  it("keeps idempotency keys per user", async () => {
    const key = randomUUID();
    await save({ meals: [meal()] }, key);
    session = B;
    const response = await save({ meals: [meal({ name: "B's lunch" })] }, key);
    const body = saveResponseSchema.parse(await response.json());
    expect(body.meals[0]!.name).toBe("B's lunch");
    expect(db.meals.map((m) => m.user_id).sort()).toEqual([A, B]);
  });

  it("saves several meals at once and summarizes today when one of them is today", async () => {
    const response = await save({
      meals: [
        meal({ name: "Yesterday's dinner", consumed_at: "2026-10-25T19:00:00-07:00" }),
        meal({ name: "Lunch", consumed_at: "2026-10-26T12:00:00-07:00" }),
      ],
    });
    const body = saveResponseSchema.parse(await response.json());
    expect(body.meals.map((m) => m.name)).toEqual(["Yesterday's dinner", "Lunch"]);
    expect(body.daily_summary.date).toBe("2026-10-26");
    expect(body.daily_summary.meals.map((m) => m.name)).toEqual(["Lunch"]);
  });

  it("summarizes the meal's own day when nothing saved is today, with the goal in effect that day", async () => {
    const response = await save({ meals: [meal({ consumed_at: "2026-10-27T09:00:00-07:00" })] });
    const body = saveResponseSchema.parse(await response.json());
    expect(body.daily_summary.date).toBe("2026-10-27");
    expect(body.daily_summary.targets).toEqual({ calories: 1800, protein_g: 160, carbs_g: 150, fat_g: 55 });
  });

  it("returns a 500 without logging meal text when the database fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db.failRpc = "save_meals";
    const response = await save({ meals: [meal({ name: "Secret Sushi Platter" })] });
    expect(response.status).toBe(500);
    expect(await errorCode(response)).toBe("internal");
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/Sushi|chicken|olive/i);
  });
});

describe("GET /api/meals and /api/meals/:id", () => {
  it("pages newest first with an opaque cursor", async () => {
    const ids: string[] = [];
    for (const hour of ["08", "12", "18"]) ids.push((await saveOne({ name: `Meal ${hour}`, consumed_at: `2026-10-26T${hour}:00:00-07:00` })).id);
    await saveOne({ name: "Same time", consumed_at: "2026-10-26T18:00:00-07:00" }); // tie on consumed_at

    const page1 = mealsPageSchema.parse(await (await list("?limit=2")).json());
    const page2 = mealsPageSchema.parse(await (await list(`?limit=2&cursor=${page1.next_cursor}`)).json());
    const all = [...page1.meals, ...page2.meals];

    expect(page1.next_cursor).not.toBeNull();
    expect(page2.next_cursor).toBeNull();
    expect(new Set(all.map((m) => m.id)).size).toBe(4);
    expect(all.at(-1)!.id).toBe(ids[0]);
    expect(all.map((m) => m.consumed_at)).toEqual([...all.map((m) => m.consumed_at)].sort().reverse());
  });

  it("filters from/to by local day in the user's time zone", async () => {
    await saveOne({ name: "Late snack", consumed_at: "2026-10-25T23:30:00-07:00" }); // 06:30 UTC on the 26th
    await saveOne({ name: "Breakfast", consumed_at: "2026-10-26T08:00:00-07:00" });

    const the25th = mealsPageSchema.parse(await (await list("?from=2026-10-25&to=2026-10-25")).json());
    expect(the25th.meals.map((m) => m.name)).toEqual(["Late snack"]);
    const both = mealsPageSchema.parse(await (await list("?from=2026-10-25&to=2026-10-26")).json());
    expect(both.meals.map((m) => m.name)).toEqual(["Breakfast", "Late snack"]);
  });

  it("searches meal names and item names", async () => {
    await saveOne({ name: "Chicken lunch" });
    await saveOne({ name: "Fruit", items: [oil({ food_name: "Banana" })] });
    const byItem = mealsPageSchema.parse(await (await list("?q=banana")).json());
    expect(byItem.meals.map((m) => m.name)).toEqual(["Fruit"]);
    const byName = mealsPageSchema.parse(await (await list("?q=LUNCH")).json());
    expect(byName.meals.map((m) => m.name)).toEqual(["Chicken lunch"]);
  });

  it("rejects a forged cursor and bad dates", async () => {
    expect((await list("?cursor=garbage")).status).toBe(400);
    const forged = Buffer.from(JSON.stringify(["2026-10-26T00:00:00Z", "x' or 1=1"])).toString("base64url");
    expect((await list(`?cursor=${forged}`)).status).toBe(400);
    expect((await list("?from=2026-10-27&to=2026-10-26")).status).toBe(400);
  });

  it("never shows another user's meals (404 by id, absent from lists)", async () => {
    const mine = await saveOne();
    session = B;
    expect((await getMeal(mine.id)).status).toBe(404);
    expect(mealsPageSchema.parse(await (await list()).json()).meals).toEqual([]);
    session = A;
    const response = await getMeal(mine.id);
    expect(response.status).toBe(200);
    expect(mealSchema.parse(await response.json())).toEqual(mine);
  });
});

describe("PATCH /api/meals/:id", () => {
  it("rejects a stale version with 409 version_conflict and changes nothing", async () => {
    const saved = await saveOne();
    expect((await patch(saved.id, { version: 1, name: "Renamed" })).status).toBe(200);

    const stale = await patch(saved.id, { version: 1, name: "Stale edit" });
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe("version_conflict");
    expect(db.meals[0]).toMatchObject({ name: "Renamed", version: 2 });
  });

  it("maps a version race inside the database to 409", async () => {
    const saved = await saveOne();
    // Another edit lands between our read and our write.
    db.beforeRpc = (name) => {
      if (name === "update_meal") db.meals[0]!.version = 2;
    };
    const response = await patch(saved.id, { version: 1, name: "Mine" });
    expect(response.status).toBe(409);
    expect(db.meals[0]!.name).toBe("Chicken lunch");
  });

  it("returns summaries for both days when the meal moves to another date", async () => {
    const stays = await saveOne({ name: "Breakfast", consumed_at: "2026-10-26T08:00:00-07:00" });
    const moves = await saveOne({ name: "Dinner" });

    const response = await patch(moves.id, { version: 1, consumed_at: "2026-10-27T19:00:00-07:00" });
    expect(response.status).toBe(200);
    const body = updateResponseSchema.parse(await response.json());

    expect(body.meal.version).toBe(2);
    expect(body.daily_summaries.map((s) => s.date)).toEqual(["2026-10-26", "2026-10-27"]);
    const [oldDay, newDay] = body.daily_summaries;
    expect(oldDay!.meals.map((m) => m.id)).toEqual([stays.id]);
    expect(oldDay!.consumed).toEqual(stays.totals);
    expect(newDay!.meals.map((m) => m.id)).toEqual([moves.id]);
    expect(newDay!.targets?.calories).toBe(1800);
    expect(db.meal_revisions.filter((r) => r.reason === "updated")).toHaveLength(1);
  });

  it("returns one summary when the date doesn't change", async () => {
    const saved = await saveOne();
    const body = updateResponseSchema.parse(await (await patch(saved.id, { version: 1, name: "Renamed" })).json());
    expect(body.daily_summaries.map((s) => s.date)).toEqual(["2026-10-26"]);
    expect(body.meal.items).toEqual(saved.items); // name-only edit leaves items alone
  });

  it("recalculates edited items, ignores tampered macros, and marks user edits", async () => {
    const saved = await saveOne();
    const [chickenItem, oilItem] = saved.items;

    const response = await patch(saved.id, {
      version: 1,
      items: [
        // 200 g now; the client's macros are wrong on purpose.
        { ...chickenItem!, grams: 200, quantity: 200, macros: { calories: 5, protein_g: 5, carbs_g: 5, fat_g: 5 } },
        // Unchanged item re-sent as-is.
        { ...oilItem! },
        // A new item.
        { id: null, ...oil({ food_name: "butter", macros: { calories: 102, protein_g: 0.1, carbs_g: 0, fat_g: 11.5 } }) },
      ],
    });
    expect(response.status).toBe(200);
    const { meal: updated } = updateResponseSchema.parse(await response.json());

    expect(updated.items.map((i) => [i.food_name, i.edited_by_user])).toEqual([
      ["grilled chicken breast", true],
      ["olive oil", false],
      ["butter", true],
    ]);
    expect(updated.items[0]!.id).toBe(chickenItem!.id);
    expect(updated.items[0]!.macros).toEqual({ calories: 330, protein_g: 62, carbs_g: 0, fat_g: 7.2 });
    expect(updated.totals).toEqual({ calories: 551.333, protein_g: 62.1, carbs_g: 0, fat_g: 32.2 });
  });

  it("removes items left out of the list", async () => {
    const saved = await saveOne();
    const body = updateResponseSchema.parse(await (await patch(saved.id, { version: 1, items: [saved.items[0]!] })).json());
    expect(body.meal.items).toHaveLength(1);
    expect(body.meal.totals).toEqual(saved.items[0]!.macros);
    expect(db.meal_items).toHaveLength(1);
  });

  it("rejects item ids that aren't on this meal", async () => {
    const mine = await saveOne();
    const other = await saveOne({ name: "Other" });
    const response = await patch(mine.id, { version: 1, items: [other.items[0]!] });
    expect(response.status).toBe(400);
    expect(apiErrorSchema.parse(await response.json()).error.fields).toHaveProperty(["items.0.id"]);
    expect(db.meals.find((m) => m.id === mine.id)!.version).toBe(1);
  });

  it("is 404 for another user's meal, which stays unchanged", async () => {
    const mine = await saveOne();
    session = B;
    const response = await patch(mine.id, { version: 1, name: "Hijacked" });
    expect(response.status).toBe(404);
    expect(db.meals[0]).toMatchObject({ name: "Chicken lunch", version: 1 });
  });

  it("rejects an empty update", async () => {
    const saved = await saveOne();
    expect((await patch(saved.id, { version: 1 })).status).toBe(400);
  });
});

describe("DELETE, undo and purge", () => {
  it("delete → undo → delete → purge", async () => {
    const lunch = await saveOne();
    const breakfast = await saveOne({ name: "Breakfast", consumed_at: "2026-10-26T08:00:00-07:00", items: [oil()] });

    // Delete: excluded from totals at once, undo window is 10 s.
    const deleted = deleteResponseSchema.parse(await (await remove(lunch.id)).json());
    expect(deleted.undo_until).toBe("2026-10-26T19:00:10.000Z");
    expect(deleted.daily_summary.meals.map((m) => m.id)).toEqual([breakfast.id]);
    expect(deleted.daily_summary.consumed).toEqual(oil().macros);
    expect(dailySummarySchema.parse(await (await daily()).json()).meals.map((m) => m.id)).toEqual([breakfast.id]);
    expect(mealsPageSchema.parse(await (await list()).json()).meals.map((m) => m.id)).toEqual([breakfast.id]);
    expect(mealSchema.parse(await (await getMeal(lunch.id)).json()).status).toBe("pending_deletion");
    expect((await remove(lunch.id)).status).toBe(404); // already deleted
    expect((await patch(lunch.id, { version: 2, name: "x" })).status).toBe(404);

    // Undo within the window.
    vi.setSystemTime(new Date(NOW.getTime() + 9_000));
    const restored = undoResponseSchema.parse(await (await undo(lunch.id)).json());
    expect(restored.meal).toMatchObject({ id: lunch.id, status: "active", version: 3 });
    expect(restored.daily_summary.meals.map((m) => m.id)).toEqual([breakfast.id, lunch.id]);
    expect((await undo(lunch.id)).status).toBe(404); // nothing left to undo

    // Delete again and let the window pass.
    expect((await remove(lunch.id)).status).toBe(200);
    vi.setSystemTime(new Date(NOW.getTime() + 9_000 + 10_000));
    const late = await undo(lunch.id);
    expect(late.status).toBe(404);
    expect(await errorCode(late)).toBe("not_found");
    expect((await getMeal(lunch.id)).status).toBe(404); // invisible before the purge runs

    // Purge hard-deletes the meal, its items and its revisions; the other meal is untouched.
    const purged = await purge("Bearer test-cron-secret");
    expect(purged.status).toBe(200);
    expect(await purged.json()).toEqual({ purged: { meals: 1, idempotency_keys: 0, temporary_uploads: 0 } });
    expect(db.meals.map((m) => m.id)).toEqual([breakfast.id]);
    expect(db.meal_items.every((item) => item.meal_id === breakfast.id)).toBe(true);
    expect(db.meal_revisions.every((rev) => rev.meal_id === breakfast.id)).toBe(true);
    expect(db.meal_revisions.map((r) => r.reason).sort()).toEqual(["created"]);
  });

  it("records deleted and restored revisions", async () => {
    const saved = await saveOne();
    await remove(saved.id);
    await undo(saved.id);
    expect(db.meal_revisions.map((r) => r.reason)).toEqual(["created", "deleted", "restored"]);
  });

  it("is 404 for another user's meal", async () => {
    const mine = await saveOne();
    session = B;
    expect((await remove(mine.id)).status).toBe(404);
    session = A;
    await remove(mine.id);
    session = B;
    expect((await undo(mine.id)).status).toBe(404);
    expect(db.meals[0]!.status).toBe("pending_deletion");
  });
});

describe("GET /api/cron/purge", () => {
  it("refuses a missing or wrong secret", async () => {
    expect((await purge()).status).toBe(401);
    expect((await purge("Bearer wrong")).status).toBe(401);
    expect((await purge("test-cron-secret")).status).toBe(401);
  });

  it("refuses everything when CRON_SECRET is unset", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("CRON_SECRET", "");
    expect((await purge("Bearer ")).status).toBe(401);
    expect((await purge("Bearer test-cron-secret")).status).toBe(401);
  });

  it("removes idempotency keys older than 24 h and expired temporary uploads", async () => {
    await saveOne();
    db.idempotency_keys.push({ user_id: A, key: "old", response: {}, created_at: "2026-10-25T18:00:00.000Z" });
    db.temporary_uploads.push(
      { id: randomUUID(), user_id: A, expires_at: "2026-10-26T18:00:00.000Z" },
      { id: randomUUID(), user_id: A, expires_at: "2026-10-26T20:00:00.000Z" },
    );
    const body = await (await purge("Bearer test-cron-secret")).json();
    expect(body).toEqual({ purged: { meals: 0, idempotency_keys: 1, temporary_uploads: 1 } });
    expect(db.idempotency_keys).toHaveLength(1);
  });
});

describe("GET /api/nutrition/daily", () => {
  it("defaults to today in the user's time zone and sums saved active meals", async () => {
    vi.setSystemTime(new Date("2026-10-27T05:00:00Z")); // still the 26th (22:00) in Los Angeles
    await saveOne({ consumed_at: "2026-10-26T21:00:00-07:00" });
    await saveOne({ consumed_at: "2026-10-27T01:00:00-07:00" }); // the 27th locally

    const summary = dailySummarySchema.parse(await (await daily()).json());
    expect(summary.date).toBe("2026-10-26");
    expect(summary.meals).toHaveLength(1);
    expect(summary.consumed).toEqual({ calories: 366.833, protein_g: 46.5, carbs_g: 0, fat_g: 18.9 });
  });

  it("uses the goal in effect on the requested date", async () => {
    const before = dailySummarySchema.parse(await (await daily("?date=2026-10-26")).json());
    const after = dailySummarySchema.parse(await (await daily("?date=2026-10-28")).json());
    const ancient = dailySummarySchema.parse(await (await daily("?date=2025-12-31")).json());
    expect(before.targets?.calories).toBe(2000);
    expect(after.targets?.calories).toBe(1800);
    expect(ancient.targets).toBeNull();
    expect(ancient.remaining).toBeNull();
    expect(after.remaining).toEqual(after.targets); // nothing eaten
  });

  it("ignores a goal that was ended before the date", async () => {
    db.nutrition_goals = [{ ...db.nutrition_goals[0]!, effective_to: "2026-10-20" }];
    const summary = dailySummarySchema.parse(await (await daily("?date=2026-10-26")).json());
    expect(summary.targets).toBeNull();
  });

  it("shows a negative remaining when over target", async () => {
    await saveOne({ items: [oil({ macros: { calories: 2500, protein_g: 0, carbs_g: 0, fat_g: 70 } })] });
    const summary = dailySummarySchema.parse(await (await daily()).json());
    expect(summary.remaining).toEqual({ calories: -500, protein_g: 150, carbs_g: 200, fat_g: -10 });
  });

  it("only counts the session user's meals", async () => {
    await saveOne();
    session = B;
    const summary = dailySummarySchema.parse(await (await daily("?date=2026-10-26")).json());
    expect(summary).toMatchObject({ timezone: "Europe/London", meals: [], consumed: { calories: 0 }, targets: null });
  });

  it("rejects a malformed date", async () => {
    expect((await daily("?date=26-10-2026")).status).toBe(400);
  });
});
