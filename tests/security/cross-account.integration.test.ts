import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtractionResult } from "@/lib/ai/extraction";
import { apiErrorSchema } from "@/lib/validation/errors";

// B15 cross-account tests (PRD §16.4) through the real route handlers, against the local Supabase
// stack with real sessions, real RLS, and the real SQL functions. Opt-in, because it needs
// `supabase start`:
//
//   SUPABASE_IT=1 npx vitest run tests/security/cross-account.integration.test.ts
//
// Keys come from the environment or from `supabase status -o env`; it refuses to run against anything
// but a local stack. It creates three throwaway users (A and B approved, C not on the allow-list) and
// deletes them, and their approved_emails rows, at the end. It never resets the database. The model
// provider and USDA are stubbed: no paid or network calls.
//
// For every route, A tries to read, change or delete B's data: B's ids in the path, body and query,
// and a `user_id` field in the body (which must be ignored). Then B's rows must be exactly as before.

const ENABLED = process.env.SUPABASE_IT === "1";

// --- Mocks: cookies come from the "current" user's jar; no model or USDA calls --------------------

let jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    set: (nameOrCookie: string | { name: string; value: string }, value?: string) => {
      const cookie = typeof nameOrCookie === "string" ? { name: nameOrCookie, value: value ?? "" } : nameOrCookie;
      jar.set(cookie.name, cookie.value);
    },
    delete: (name: string) => jar.delete(name),
  }),
}));

const extractMeal = vi.fn();
vi.mock("@/lib/ai/providers", () => ({
  getProvider: () => ({ name: "anthropic", model: "claude-haiku-5-5", extractMeal, chat: vi.fn() }),
}));
vi.mock("@/lib/nutrition/usda", async (original) => ({
  ...(await original<typeof import("@/lib/nutrition/usda")>()),
  searchFoods: vi.fn(async () => []),
  getFood: vi.fn(async () => null),
}));

const { api, chickenItem, valid } = await import("./route-table");

// --- Local stack --------------------------------------------------------------------------------

function localEnv(): { url: string; anonKey: string; serviceKey: string } {
  let url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  let anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  let serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey || !serviceKey) {
    const status = execSync("supabase status -o env", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const value = (name: string) => status.match(new RegExp(`^${name}="?([^"\\n]*)"?$`, "m"))?.[1];
    url = value("API_URL");
    anonKey = value("ANON_KEY");
    serviceKey = value("SERVICE_ROLE_KEY");
  }
  if (!url || !anonKey || !serviceKey) throw new Error("Local Supabase keys not found: run `supabase start`.");
  // This test creates and deletes users: never point it at a hosted project.
  if (!["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
    throw new Error(`Refusing to run against ${url}: the cross-account test only runs against a local stack.`);
  }
  return { url, anonKey, serviceKey };
}

interface TestUser {
  id: string;
  email: string;
  cookies: Map<string, string>;
}

const RUN = randomUUID().slice(0, 8);
const PASSWORD = `b15-${randomUUID()}`;
const emailFor = (who: string) => `b15-${who}-${RUN}@security.test`;

// B's data, chosen so any leak shows up in a response body as one of these strings.
const B_MEAL = `b-secret-dinner-${RUN}`;
const B_PENDING_MEAL = `b-pending-meal-${RUN}`;
const B_FOOD = `b-secret-food-${RUN}`;
const B_MEMORY = `Eggs b-secret-memory-${RUN}`;
const B_GOALS = { calories: 3333, protein_g: 177, carbs_g: 333, fat_g: 99 };

let env: ReturnType<typeof localEnv>;
let admin: SupabaseClient;
const created: string[] = [];
let A: TestUser;
let B: TestUser;
let C: TestUser;

async function createUser(who: string, approved: boolean): Promise<TestUser> {
  const email = emailFor(who);
  if (approved) {
    const { error } = await admin.from("approved_emails").insert({ email });
    if (error) throw new Error(`approved_emails insert failed: ${error.message}`);
  }
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  created.push(data.user.id);

  // Sign in the way the browser does, so the route sees real @supabase/ssr session cookies.
  const cookies = new Map<string, string>();
  const client = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach(({ name, value }) => (value ? cookies.set(name, value) : cookies.delete(name))),
    },
  });
  const signIn = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error) throw new Error(`sign-in failed: ${signIn.error.message}`);
  await new Promise((resolve) => setTimeout(resolve, 50)); // let the SIGNED_IN cookie write land
  if (cookies.size === 0) throw new Error("sign-in wrote no session cookies");
  return { id: data.user.id, email, cookies };
}

// Run a request as `user` (null = no session).
async function as<T>(user: TestUser | null, call: () => Promise<T>): Promise<T> {
  jar = user ? user.cookies : new Map();
  return call();
}

async function body(response: Response): Promise<string> {
  return response.clone().text();
}

// Nothing of B's may appear in a response A receives.
async function expectNoLeak(response: Response) {
  const text = await body(response);
  for (const secret of [B.id, B.email, B_MEAL, B_PENDING_MEAL, B_FOOD, B_MEMORY, `"calories":${B_GOALS.calories}`]) {
    expect(text, `response leaks B's ${secret}`).not.toContain(secret);
  }
}

async function expectError(response: Response, status: number, code: string) {
  await expectNoLeak(response);
  expect(response.status).toBe(status);
  expect(apiErrorSchema.parse(await response.json()).error.code).toBe(code);
}

async function rows(table: string, column: string, value: string | string[]) {
  const query = admin.from(table).select("*");
  const { data, error } = await (Array.isArray(value) ? query.in(column, value) : query.eq(column, value));
  if (error) throw new Error(`${table} select failed: ${error.message}`);
  return data.map((row) => JSON.stringify(row)).sort(); // stable order, compared as text
}

// Every row B owns, read with the service role.
async function snapshotOf(user: TestUser) {
  const meals = await rows("meals", "user_id", user.id);
  return {
    profiles: await rows("profiles", "id", user.id),
    account_preferences: await rows("account_preferences", "user_id", user.id),
    nutrition_goals: await rows("nutrition_goals", "user_id", user.id),
    meals,
    meal_items: await rows("meal_items", "meal_id", meals.map((meal) => (JSON.parse(meal) as { id: string }).id)),
    meal_revisions: await rows("meal_revisions", "user_id", user.id),
    user_memories: await rows("user_memories", "user_id", user.id),
    ai_usage: await rows("ai_usage", "user_id", user.id),
    idempotency_keys: await rows("idempotency_keys", "user_id", user.id),
  };
}

const extraction: ExtractionResult = {
  intent: "log_meal",
  explanation: null,
  meals: [
    {
      name: "Eggs",
      consumed_at: null,
      time_phrase: null,
      needs_clarification: false,
      clarification_question: null,
      foods: [
        {
          name: "Eggs",
          brand: null,
          quantity: 2,
          unit: "egg",
          grams: 100,
          preparation: "boiled",
          estimated_quantity: false,
          inferred: false,
          confidence: "high",
          search_query: "egg, whole, cooked",
          estimated_macros: { calories: 155, protein_g: 12.6, carbs_g: 1.1, fat_g: 10.6 },
          estimate_range: { calories_low: 140, calories_high: 170, protein_g_low: 11, protein_g_high: 14 },
          notes: null,
        },
      ],
    },
  ],
};

// --- Fixtures -------------------------------------------------------------------------------------

const MINUTE = 60_000;
const recent = (minutesAgo: number) => new Date(Date.now() - minutesAgo * MINUTE).toISOString();

let bMealId: string;
let bItemId: string;
let bPendingId: string;
let bMemoryId: string;
let bIdempotencyKey: string;
let aMealId: string;
let bBefore: Awaited<ReturnType<typeof snapshotOf>>;

async function saveMeal(user: TestUser, name: string, food: string, key: string = randomUUID()) {
  const response = await as(user, () =>
    api.saveMeals(
      { meals: [{ proposal_id: null, name, consumed_at: recent(5), source_type: "text", items: [chickenItem({ food_name: food })] }] },
      key,
    ),
  );
  expect(response.status).toBe(201);
  return (await response.json()).meals[0] as { id: string; items: Array<{ id: string }> };
}

describe.skipIf(!ENABLED)("cross-account access through every API route (local Supabase)", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    env = localEnv();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", env.url);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", env.anonKey);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", env.serviceKey);
    vi.stubEnv("CRON_SECRET", `cron-${randomUUID()}`);
    vi.stubEnv("AI_DAILY_CALL_CAP", "50");
    vi.spyOn(console, "error").mockImplementation(() => {});
    admin = createClient(env.url, env.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

    A = await createUser("a", true);
    B = await createUser("b", true);
    C = await createUser("c", false);

    // B's data, written through the routes as B.
    expect((await as(B, () => api.putGoals(B_GOALS))).status).toBe(200);
    expect((await as(B, () => api.patchPreferences({ theme: "light", save_mode: "auto" }))).status).toBe(200);
    bIdempotencyKey = randomUUID();
    const bMeal = await saveMeal(B, B_MEAL, B_FOOD, bIdempotencyKey);
    bMealId = bMeal.id;
    bItemId = bMeal.items[0]!.id;
    bPendingId = (await saveMeal(B, B_PENDING_MEAL, B_FOOD)).id;
    expect((await as(B, () => api.deleteMeal(bPendingId))).status).toBe(200); // inside its undo window for 10 s
    // No route creates memories (extraction does), so B's is inserted with the service role. A
    // response_style memory goes to the model on every message, so a leak can't hide behind relevance.
    const memory = await admin
      .from("user_memories")
      .insert({ user_id: B.id, category: "response_style", content: B_MEMORY })
      .select("id")
      .single();
    if (memory.error) throw new Error(memory.error.message);
    bMemoryId = memory.data.id;
    // B has not finished onboarding: A finishing theirs must not change that.

    // A's own data.
    expect((await as(A, () => api.putGoals(valid.goals))).status).toBe(200);
    aMealId = (await saveMeal(A, "A lunch", "a food")).id;
    await admin.from("user_memories").insert({ user_id: A.id, category: "brand", content: "Eggs: usually 2 large eggs" });

    bBefore = await snapshotOf(B);
    expect(bBefore.meals).toHaveLength(2);
    expect(bBefore.user_memories).toHaveLength(1);
  });

  afterAll(async () => {
    // Deleting the auth user cascades to every row they own (supabase/tests/account_deletion.test.sql).
    for (const id of created) await admin?.auth.admin.deleteUser(id);
    if (admin) await admin.from("approved_emails").delete().in("email", [emailFor("a"), emailFor("b"), emailFor("c")]);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // --- Reads ------------------------------------------------------------------------------------

  it("GET /api/me returns A, whatever the query says", async () => {
    const response = await as(A, () => api.me());
    await expectNoLeak(response);
    expect(await response.json()).toMatchObject({ user_id: A.id, email: A.email });
  });

  it("GET /api/meals never lists B's meals (search, user_id param, or a cursor built from B's meal)", async () => {
    const cursor = Buffer.from(JSON.stringify([new Date(Date.now() + MINUTE).toISOString(), bMealId])).toString("base64url");
    for (const query of ["", `?q=${B_MEAL}`, `?q=${B_FOOD}`, `?user_id=${B.id}`, `?cursor=${cursor}`]) {
      const response = await as(A, () => api.listMeals(query));
      await expectNoLeak(response);
      expect(response.status).toBe(200);
      const ids = (await response.json()).meals.map((meal: { id: string }) => meal.id);
      expect(ids).not.toContain(bMealId);
      expect(ids).not.toContain(bPendingId);
    }
  });

  it("GET /api/meals/:id is 404 for B's meals", async () => {
    await expectError(await as(A, () => api.getMeal(bMealId)), 404, "not_found");
    await expectError(await as(A, () => api.getMeal(bPendingId)), 404, "not_found");
  });

  it("GET /api/nutrition/daily counts only A's meals and A's targets", async () => {
    for (const query of ["", `?user_id=${B.id}`]) {
      const response = await as(A, () => api.daily(query));
      await expectNoLeak(response);
      const summary = await response.json();
      expect(summary.meals.map((meal: { id: string }) => meal.id)).toEqual([aMealId]);
      expect(summary.targets.calories).toBe(valid.goals.calories);
    }
  });

  it("GET /api/goals and GET /api/preferences return A's own", async () => {
    const goals = await as(A, () => api.getGoals());
    await expectNoLeak(goals);
    expect((await goals.json()).calories).toBe(valid.goals.calories);
    const prefs = await as(A, () => api.getPreferences());
    await expectNoLeak(prefs);
    expect(await prefs.json()).toMatchObject({ theme: "system", save_mode: "confirm" });
  });

  it("GET /api/memories never lists B's memories", async () => {
    const response = await as(A, () => api.listMemories());
    await expectNoLeak(response);
    expect((await response.json()).memories.map((m: { content: string }) => m.content)).toEqual(["Eggs: usually 2 large eggs"]);
  });

  it("GET /api/export (every format and scope) contains only A's data", async () => {
    for (const query of ["?format=json", "?format=csv", "?format=json&scope=account", `?format=json&scope=account&user_id=${B.id}`]) {
      const response = await as(A, () => api.exportData(query));
      expect(response.status).toBe(200);
      await expectNoLeak(response);
    }
    const account = await (await as(A, () => api.exportData("?format=json&scope=account"))).text();
    expect(account).toContain("A lunch");
    expect(account).toContain("Eggs: usually 2 large eggs");
  });

  // --- Writes -----------------------------------------------------------------------------------

  it("POST /api/meals saves as the session user, ignoring user_id in the body", async () => {
    const response = await as(A, () =>
      api.saveMeals({ user_id: B.id, meals: [{ ...valid.saveMeals("A smuggled", recent(3)).meals[0], user_id: B.id }] }),
    );
    await expectNoLeak(response);
    expect(response.status).toBe(201);
    const saved = (await response.json()).meals[0];
    const { data } = await admin.from("meals").select("user_id").eq("id", saved.id).single();
    expect(data!.user_id).toBe(A.id);
  });

  it("POST /api/meals with B's Idempotency-Key saves A's meal instead of replaying B's", async () => {
    const response = await as(A, () => api.saveMeals(valid.saveMeals("A same key", recent(2)), bIdempotencyKey));
    await expectNoLeak(response);
    expect(response.status).toBe(201);
    expect(response.headers.get("idempotency-replayed")).toBeNull();
    expect((await response.json()).meals[0].name).toBe("A same key");
  });

  it("PATCH /api/meals/:id cannot touch B's meal, or pull B's items into A's", async () => {
    await expectError(await as(A, () => api.patchMeal(bMealId, { version: 1, name: "pwned" })), 404, "not_found");
    await expectError(await as(A, () => api.patchMeal(bPendingId, { version: 2, name: "pwned" })), 404, "not_found");
    // B's item id on A's own meal.
    const stolen = await as(A, () =>
      api.patchMeal(aMealId, { version: 1, items: [{ ...chickenItem(), id: bItemId }] }),
    );
    await expectError(stolen, 400, "validation_error");
    // user_id in the body is ignored: the meal stays A's.
    const renamed = await as(A, () => api.patchMeal(aMealId, { version: 1, name: "A lunch", user_id: B.id }));
    expect(renamed.status).toBe(200);
    await expectNoLeak(renamed);
    const { data } = await admin.from("meals").select("user_id").eq("id", aMealId).single();
    expect(data!.user_id).toBe(A.id);
  });

  it("DELETE /api/meals/:id and POST /api/meals/:id/undo are 404 for B's meals", async () => {
    await expectError(await as(A, () => api.deleteMeal(bMealId)), 404, "not_found");
    await expectError(await as(A, () => api.deleteMeal(bPendingId)), 404, "not_found");
    await expectError(await as(A, () => api.undoDelete(bPendingId)), 404, "not_found");
    await expectError(await as(A, () => api.undoDelete(bMealId)), 404, "not_found");
  });

  it("PUT /api/goals, PATCH /api/preferences and goals/suggest ignore user_id in the body", async () => {
    const goals = await as(A, () => api.putGoals({ ...valid.goals, calories: 2050, user_id: B.id }));
    await expectNoLeak(goals);
    expect(goals.status).toBe(200);
    const prefs = await as(A, () => api.patchPreferences({ theme: "dark", user_id: B.id }));
    // The preferences schema is strict: an unknown key is a 400, and nothing is written.
    await expectError(prefs, 400, "validation_error");
    const suggest = await as(A, () => api.suggestGoals({ ...valid.suggest, user_id: B.id }));
    expect(suggest.status).toBe(200);
    await expectNoLeak(suggest);
  });

  it("POST /api/onboarding/complete only finishes A's onboarding", async () => {
    const response = await as(A, () => api.completeOnboarding());
    await expectNoLeak(response);
    expect(await response.json()).toMatchObject({ user_id: A.id, onboarding_complete: true });
  });

  it("PATCH and DELETE /api/memories/:id are 404 for B's memory", async () => {
    await expectError(await as(A, () => api.patchMemory(bMemoryId, { content: "pwned", user_id: B.id })), 404, "not_found");
    await expectError(await as(A, () => api.deleteMemory(bMemoryId)), 404, "not_found");
  });

  it("POST /api/ai/analyze-meal uses only A's memories and records usage for A", async () => {
    extractMeal.mockResolvedValue({ result: extraction, usage: { inputTokens: 10, outputTokens: 5 }, model: "claude-haiku-5-5", promptVersion: "test" });
    const response = await as(A, () => api.analyzeMeal({ text: "2 eggs", timezone: "UTC", user_id: B.id }));
    expect(response.status).toBe(200);
    await expectNoLeak(response);
    expect(extractMeal).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(extractMeal.mock.calls);
    expect(sent).toContain("Eggs: usually 2 large eggs"); // A's memory does reach the model
    expect(sent).not.toContain(B_MEMORY);
    expect(sent).not.toContain(B.id);
    const { data } = await admin.from("ai_usage").select("user_id").eq("user_id", A.id);
    expect(data).toHaveLength(1);
  });

  // --- Unapproved, signed out, cron -------------------------------------------------------------

  it("an unapproved signed-in account gets 403 not_approved everywhere, even with B's ids", async () => {
    for (const call of [
      () => api.me(),
      () => api.listMeals(),
      () => api.saveMeals(valid.saveMeals()),
      () => api.getMeal(bMealId),
      () => api.patchMeal(bMealId, { version: 1, name: "pwned" }),
      () => api.deleteMeal(bMealId),
      () => api.undoDelete(bPendingId),
      () => api.daily(),
      () => api.getGoals(),
      () => api.putGoals(valid.goals),
      () => api.suggestGoals(valid.suggest),
      () => api.getPreferences(),
      () => api.patchPreferences(valid.preferences),
      () => api.completeOnboarding(),
      () => api.listMemories(),
      () => api.patchMemory(bMemoryId, valid.memory),
      () => api.deleteMemory(bMemoryId),
      () => api.exportData("?format=json&scope=account"),
      () => api.deleteAccount(valid.account),
      () => api.analyzeMeal(valid.analyze),
    ]) {
      await expectError(await as(C, call), 403, "not_approved");
    }
    const { data } = await admin.auth.admin.getUserById(C.id);
    expect(data.user).not.toBeNull(); // DELETE /api/account did nothing
  });

  it("no session gets 401 unauthenticated everywhere", async () => {
    for (const call of [
      () => api.me(),
      () => api.listMeals(),
      () => api.getMeal(bMealId),
      () => api.patchMeal(bMealId, { version: 1, name: "pwned" }),
      () => api.deleteMeal(bMealId),
      () => api.daily(),
      () => api.putGoals(valid.goals),
      () => api.patchPreferences(valid.preferences),
      () => api.completeOnboarding(),
      () => api.listMemories(),
      () => api.deleteMemory(bMemoryId),
      () => api.exportData("?format=json"),
      () => api.deleteAccount(valid.account),
      () => api.analyzeMeal(valid.analyze),
    ]) {
      await expectError(await as(null, call), 401, "unauthenticated");
    }
  });

  it("GET /api/cron/purge rejects a missing or wrong secret, and a user's session", async () => {
    await expectError(await as(null, () => api.purge()), 401, "unauthenticated");
    await expectError(await as(null, () => api.purge({ authorization: "Bearer wrong" })), 401, "unauthenticated");
    await expectError(await as(A, () => api.purge()), 401, "unauthenticated");
  });

  // --- Last: account deletion, then B must be exactly as it was --------------------------------

  it("DELETE /api/account deletes A, never B, whatever the body says", async () => {
    const response = await as(A, () => api.deleteAccount({ confirm: "DELETE", user_id: B.id }));
    expect(response.status).toBe(204);
    expect((await admin.auth.admin.getUserById(A.id)).data.user).toBeNull();
    expect((await admin.auth.admin.getUserById(B.id)).data.user).not.toBeNull();
  });

  it("B's rows are unchanged after everything A tried", async () => {
    expect(await snapshotOf(B)).toEqual(bBefore);
    // And B still sees their own data through the API.
    const response = await as(B, () => api.getMeal(bMealId));
    expect(response.status).toBe(200);
    expect((await response.json()).name).toBe(B_MEAL);
  });
});
