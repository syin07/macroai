import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { errorCodeSchema } from "@/lib/validation/errors";
import {
  APPROVED_USER,
  createFakeSupabase,
  signedIn,
  signedOut,
  stubSupabaseEnv,
  type FakeAuthState,
  type FakeSupabase,
} from "@/lib/auth/__fixtures__/fake-supabase";
import { createAppDb } from "@/lib/database/__fixtures__/memory-supabase";

// B15 security tests (PRD §16.4) that need no database: every API route runs its real requireUser()
// against a fake Supabase client, so these run in `npm test`. Cross-account access against a real
// Postgres with RLS is in cross-account.integration.test.ts.
//
// 1. Every route and method is listed in route-table.ts (so new routes get these checks).
// 2. No session → 401 unauthenticated; signed in but not approved → 403 not_approved. Neither touches
//    data, the model, or the service role.
// 3. The cron route only accepts `Authorization: Bearer $CRON_SECRET`.
// 4. Internal failures (database errors returned or thrown, Auth unreachable, provider errors) answer
//    with a contract ApiError and nothing else: no stack trace, SQL, error text, or ids.

// --- Mocks ----------------------------------------------------------------------------------------

let client: unknown;
vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn(() => client) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: vi.fn(), delete: vi.fn() }) }));

// The service-role client. `null` = not configured (createServiceRoleClient throws, like a missing key).
let admin: unknown = null;
const createServiceRoleClient = vi.fn(() => {
  if (!admin) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  return admin;
});
vi.mock("@/lib/database/admin", () => ({ createServiceRoleClient: () => createServiceRoleClient() }));

// No paid model calls: the provider is a stub.
const extractMeal = vi.fn();
const chat = vi.fn();
vi.mock("@/lib/ai/providers", () => ({
  getProvider: () => ({ name: "anthropic", model: "claude-haiku-5-5", extractMeal, chat }),
}));
// No USDA calls either.
vi.mock("@/lib/nutrition/usda", async (original) => ({
  ...(await original<typeof import("@/lib/nutrition/usda")>()),
  searchFoods: vi.fn(async () => []),
  getFood: vi.fn(async () => null),
}));
// goals/suggest is pure math; wrap it so a test can make it throw.
const suggestGoals = vi.hoisted(() => vi.fn());
vi.mock("@/lib/nutrition/goals", async (original) => {
  const real = await original<typeof import("@/lib/nutrition/goals")>();
  suggestGoals.mockImplementation(real.suggestGoals);
  return { ...real, suggestGoals };
});

const { api, cronRoutes, discoverRoutes, userRoutes } = await import("./route-table");

// --- Helpers --------------------------------------------------------------------------------------

const ME = APPROVED_USER.id;
const SOME_ID = "b0000000-0000-4000-8000-000000000001";
const CRON_SECRET = "test-cron-secret-0123456789";

// What a database or driver error might carry: SQL, constraint and column names, another user's id.
const LEAK_MARKER = "leak-marker-5c1f";
const INTERNAL_DETAIL =
  `${LEAK_MARKER}: duplicate key value violates unique constraint "meals_pkey" ` +
  `DETAIL: Key (user_id)=(22222222-2222-4222-8222-222222222222) SELECT * FROM public.meals WHERE user_id = $1`;

// The contract ApiError and nothing more (strict at both levels).
const strictApiError = z.strictObject({
  error: z.strictObject({
    code: errorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
    fields: z.record(z.string(), z.string()).optional(),
  }),
});

const DEFAULT_MESSAGES = {
  unauthenticated: "Please sign in again.",
  not_approved: "This account hasn't been approved.",
  internal: "Something went wrong. Please try again.",
  ai_unavailable: "The assistant is unavailable right now. Please try again.",
} as const;

// Fragments that must never appear in an error response body.
const FORBIDDEN = [
  LEAK_MARKER,
  "SELECT",
  "DETAIL",
  "Key (",
  "meals_pkey",
  "constraint",
  "22222222",
  "    at ", // stack frame
  "node_modules",
  ".ts:",
  "Error:",
  "TypeError",
  "stack",
  "SUPABASE",
  "service_role",
];

async function expectCleanError(response: Response, status: number, code: keyof typeof DEFAULT_MESSAGES) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toMatch(/^application\/json/);
  const text = await response.text();
  const body = strictApiError.parse(JSON.parse(text));
  expect(body.error.code).toBe(code);
  expect(body.error.message).toBe(DEFAULT_MESSAGES[code]);
  expect(body.error.fields).toBeUndefined();
  for (const fragment of FORBIDDEN) expect(text, `body contains ${JSON.stringify(fragment)}`).not.toContain(fragment);
}

// A PostgREST-style query builder where every query fails: either it resolves with an error result
// (how supabase-js reports database errors) or it rejects (a driver or network failure).
type FailMode = "returned" | "thrown";

function dbError() {
  return { code: "23505", message: INTERNAL_DETAIL, details: INTERNAL_DETAIL, hint: `Check ${LEAK_MARKER}` };
}

function failingResult(mode: FailMode) {
  if (mode === "thrown") return Promise.reject(new TypeError(`fetch failed: ${INTERNAL_DETAIL}`));
  return Promise.resolve({ data: null, error: dbError(), count: null, status: 500, statusText: "Internal Server Error" });
}

function failingBuilder(mode: FailMode): unknown {
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            failingResult(mode).then(resolve, reject);
        }
        if (prop === "single" || prop === "maybeSingle") return () => failingResult(mode);
        if (typeof prop === "symbol") return undefined;
        return () => builder;
      },
    },
  );
  return builder;
}

// A signed-in, approved user whose every database read and write fails.
function failingClient(auth: FakeSupabase, mode: FailMode) {
  return {
    auth: auth.auth,
    from: vi.fn(() => failingBuilder(mode)),
    rpc: vi.fn(async (name: string) => (name === "is_approved" ? { data: true, error: null } : failingResult(mode))),
  };
}

function failingAdmin(mode: FailMode) {
  return {
    from: () => failingBuilder(mode),
    rpc: () => failingResult(mode),
    auth: {
      admin: {
        deleteUser: async () => {
          if (mode === "thrown") throw new TypeError(`fetch failed: ${INTERNAL_DETAIL}`);
          return { data: { user: null }, error: { name: "AuthApiError", status: 500, message: INTERNAL_DETAIL } };
        },
      },
    },
  };
}

// Server logs get the error's name and message (and at most a status code) as text (handleRouteError), never an Error object:
// console.error(error) prints the stack and any properties a driver attached.
function expectStringLogs() {
  expect(errorLog).toHaveBeenCalled();
  for (const args of errorLog.mock.calls) {
    for (const arg of args) expect(["string", "number"], `logged a ${typeof arg}: ${String(arg)}`).toContain(typeof arg);
    expect(args.join(" ")).not.toContain("    at ");
  }
}

let auth: FakeSupabase;
let errorLog: ReturnType<typeof vi.spyOn>;

function given(state: FakeAuthState) {
  auth = createFakeSupabase(state);
  client = auth;
}

beforeEach(() => {
  stubSupabaseEnv();
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  vi.stubEnv("AI_DAILY_CALL_CAP", "50");
  admin = null;
  createServiceRoleClient.mockClear();
  extractMeal.mockReset();
  chat.mockReset();
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  errorLog.mockRestore();
});

// --- 1. Coverage ----------------------------------------------------------------------------------

describe("route coverage", () => {
  it("covers every exported handler under src/app/api", async () => {
    const covered = [...userRoutes(SOME_ID).map(([key]) => key), ...cronRoutes].sort();
    const missing = (await discoverRoutes()).filter((key) => !covered.includes(key));
    expect(
      missing,
      "New API routes need security coverage: add them to tests/security/route-table.ts " +
        "(api, userRoutes) and to the cross-account integration test",
    ).toEqual([]);
  });

  it("lists no route that no longer exists", async () => {
    const discovered = await discoverRoutes();
    const covered = [...userRoutes(SOME_ID).map(([key]) => key), ...cronRoutes];
    expect(covered.filter((key) => !discovered.includes(key))).toEqual([]);
  });
});

// --- 2. Authentication and approval ---------------------------------------------------------------

describe("no session", () => {
  it.each(userRoutes(SOME_ID))("%s → 401 unauthenticated, touching nothing", async (_key, call) => {
    given(signedOut());
    await expectCleanError(await call(), 401, "unauthenticated");
    expect(auth.from).not.toHaveBeenCalled();
    expect(auth.rpc).not.toHaveBeenCalled();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(extractMeal).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });
});

describe("signed in but not approved", () => {
  it.each(userRoutes(SOME_ID))("%s → 403 not_approved, touching nothing", async (_key, call) => {
    given(signedIn(false));
    await expectCleanError(await call(), 403, "not_approved");
    expect(auth.rpc).toHaveBeenCalledExactlyOnceWith("is_approved");
    expect(auth.from).not.toHaveBeenCalled();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(extractMeal).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it("is still 403 when the body names an approved user", async () => {
    given(signedIn(false));
    await expectCleanError(await api.putGoals({ ...{ calories: 2000, protein_g: 1, carbs_g: 1, fat_g: 1 }, user_id: ME }), 403, "not_approved");
    await expectCleanError(await api.analyzeMeal({ text: "eggs", timezone: "UTC", user_id: ME }), 403, "not_approved");
  });
});

// --- 3. Cron secret -------------------------------------------------------------------------------

describe("GET /api/cron/purge", () => {
  beforeEach(() => given(signedIn(true))); // a signed-in user's session must not be enough

  it.each([
    ["no Authorization header", {}],
    ["an empty bearer token", { authorization: "Bearer " }],
    ["the wrong secret", { authorization: "Bearer not-the-secret" }],
    ["the secret without the Bearer scheme", { authorization: CRON_SECRET }],
    ["the secret with another scheme", { authorization: `Basic ${CRON_SECRET}` }],
    ["a prefix of the secret", { authorization: `Bearer ${CRON_SECRET.slice(0, -1)}` }],
    ["the secret plus extra characters", { authorization: `Bearer ${CRON_SECRET}x` }],
    ["a lowercase scheme", { authorization: `bearer ${CRON_SECRET}` }],
    ["a user's session cookie instead", { cookie: "sb-127-auth-token=base64-eyJ" }],
  ])("rejects %s with 401, without the service role", async (_case, headers) => {
    await expectCleanError(await api.purge(headers as Record<string, string>), 401, "unauthenticated");
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
  ])("refuses every request while CRON_SECRET is %s", async (_case, value) => {
    vi.stubEnv("CRON_SECRET", value);
    for (const authorization of ["Bearer ", "Bearer undefined", "Bearer"]) {
      await expectCleanError(await api.purge({ authorization }), 401, "unauthenticated");
    }
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("runs with the right secret (positive control)", async () => {
    const rpc = vi.fn(async () => ({ data: { meals: 0, idempotency_keys: 0, temporary_uploads: 0 }, error: null }));
    admin = { rpc };
    const response = await api.purge({ authorization: `Bearer ${CRON_SECRET}` });
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("purge_expired");
  });
});

// --- 4. Error hygiene -----------------------------------------------------------------------------

describe.each<FailMode>(["returned", "thrown"])("database errors (%s)", (mode) => {
  beforeEach(() => {
    given(signedIn(true));
    client = failingClient(auth, mode);
    admin = failingAdmin(mode);
  });

  const exceptions = ["POST /api/goals/suggest"]; // no database access; covered below
  it.each(userRoutes(SOME_ID).filter(([key]) => !exceptions.includes(key)))(
    "%s → 500 internal with a clean body",
    async (_key, call) => {
      await expectCleanError(await call(), 500, "internal");
      expect(extractMeal).not.toHaveBeenCalled();
      expect(chat).not.toHaveBeenCalled();
      expectStringLogs();
    },
  );

  it("GET /api/cron/purge → 500 internal with a clean body", async () => {
    await expectCleanError(await api.purge({ authorization: `Bearer ${CRON_SECRET}` }), 500, "internal");
    expectStringLogs();
  });
});

describe("other internal failures", () => {
  it.each(userRoutes(SOME_ID))("%s → 500 when the Auth server is unreachable", async (_key, call) => {
    given(signedIn(true, { authUnreachable: true }));
    await expectCleanError(await call(), 500, "internal");
  });

  it.each(userRoutes(SOME_ID))("%s → 500 when is_approved() fails", async (_key, call) => {
    given(signedIn(true, { rpcError: INTERNAL_DETAIL }));
    await expectCleanError(await call(), 500, "internal");
  });

  it("POST /api/goals/suggest → 500 when the calculation throws", async () => {
    given(signedIn(true));
    suggestGoals.mockImplementationOnce(() => {
      throw new RangeError(INTERNAL_DETAIL);
    });
    await expectCleanError(await api.suggestGoals({ age: 35, height_cm: 170, weight_kg: 70, sex: "female", activity: "moderate", goal: "maintain" }), 500, "internal");
  });

  it("POST /api/ai/analyze-meal → 503 when the provider fails, without echoing its error", async () => {
    given(signedIn(true));
    const db = createAppDb({ profiles: [{ id: ME, timezone: "UTC" }] });
    client = { ...auth, from: db.from };
    extractMeal.mockRejectedValue(new Error(`Anthropic 500: ${INTERNAL_DETAIL} sk-ant-api03-not-a-real-key`));
    await expectCleanError(await api.analyzeMeal({ text: "2 eggs and toast", timezone: "UTC" }), 503, "ai_unavailable");
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("2 eggs and toast");
  });

  it("POST /api/ai/chat → 503 when the provider fails, without echoing its error or the message", async () => {
    given(signedIn(true));
    const db = createAppDb({
      profiles: [{ id: ME, timezone: "UTC" }],
      account_preferences: [{ user_id: ME, theme: "system", save_mode: "confirm", assistant_style: "casual" }],
    });
    client = { ...auth, from: db.from };
    chat.mockRejectedValue(Object.assign(new Error(`Anthropic 500: ${INTERNAL_DETAIL} sk-ant-api03-not-a-real-key`), { status: 500 }));
    await expectCleanError(await api.chat({ text: "2 eggs and toast" }), 503, "ai_unavailable");
    expect(chat).toHaveBeenCalled();
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("2 eggs and toast");
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(LEAK_MARKER);
    // The failed message is kept for a retry, marked as an error, with no image and no error text.
    expect(db.rows("messages").map((row) => [row.role, row.status])).toEqual([["user", "error"]]);
    expect(JSON.stringify(db.rows("messages"))).not.toContain(LEAK_MARKER);
  });
});
