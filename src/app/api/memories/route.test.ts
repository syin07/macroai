import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Memory } from "@/types/api";
import { apiErrorSchema } from "@/lib/validation/errors";
import { memoriesResponseSchema, memorySchema } from "@/lib/validation";
import {
  APPROVED_USER,
  createFakeSupabase,
  signedIn,
  signedOut,
  stubSupabaseEnv,
  type FakeAuthState,
} from "@/lib/auth/__fixtures__/fake-supabase";
import { createAppDb, type MemoryDb } from "@/lib/database/__fixtures__/memory-supabase";

let fake: unknown;
vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn(() => fake) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: vi.fn() }) }));

const { GET } = await import("./route");
const { PATCH, DELETE } = await import("./[id]/route");

const ME = APPROVED_USER.id;
const OTHER = "22222222-2222-4222-8222-222222222222";

const MINE_OLD = "a0000000-0000-4000-8000-000000000001";
const MINE_NEW = "a0000000-0000-4000-8000-000000000002";
const MINE_DELETED = "a0000000-0000-4000-8000-000000000003";
const THEIRS = "b0000000-0000-4000-8000-000000000001";
const MISSING = "c0000000-0000-4000-8000-000000000001";

const row = (id: string, user_id: string, content: string, created_at: string, extra: Record<string, unknown> = {}) => ({
  id,
  user_id,
  category: "frequent_food",
  content,
  source_message_id: null,
  created_at,
  updated_at: created_at,
  deleted_at: null,
  ...extra,
});

const ROWS = [
  row(MINE_OLD, ME, "Usual shake: Fairlife Core Power 26g, 1 bottle", "2026-10-01T08:00:00+00:00"),
  row(MINE_NEW, ME, "Keep replies short", "2026-10-20T08:00:00+00:00", { category: "response_style" }),
  row(MINE_DELETED, ME, "Oat milk: Oatly", "2026-10-10T08:00:00+00:00", { deleted_at: "2026-10-21T08:00:00+00:00" }),
  row(THEIRS, OTHER, "Usual shake: Huel", "2026-10-05T08:00:00+00:00"),
];

let db: MemoryDb;

function given(state: FakeAuthState, fail?: Parameters<typeof createAppDb>[1]) {
  db = createAppDb({ user_memories: ROWS }, fail);
  fake = { ...createFakeSupabase(state), from: db.from };
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function patch(id: string, body: unknown) {
  return PATCH(
    new Request(`http://localhost/api/memories/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    params(id),
  );
}

const del = (id: string) => DELETE(new Request(`http://localhost/api/memories/${id}`, { method: "DELETE" }), params(id));

const theirsUnchanged = () => expect(db.rows("user_memories").find((r) => r.id === THEIRS)).toEqual(ROWS[3]);

async function errorCode(response: Response) {
  return apiErrorSchema.parse(await response.json()).error.code;
}

describe("/api/memories", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stubSupabaseEnv();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["GET", () => GET()],
    ["PATCH", () => patch(MINE_OLD, { content: "x" })],
    ["DELETE", () => del(MINE_OLD)],
  ])("%s returns 401 without a session and 403 for an unapproved account, before touching memories", async (_, call) => {
    given(signedOut());
    const unauthenticated = await call();
    expect(unauthenticated.status).toBe(401);
    expect(await errorCode(unauthenticated)).toBe("unauthenticated");

    given(signedIn(false));
    const unapproved = await call();
    expect(unapproved.status).toBe(403);
    expect(await errorCode(unapproved)).toBe("not_approved");
    expect(db.from).not.toHaveBeenCalled();
  });

  describe("GET", () => {
    it("lists the user's live memories, newest first, in the contract shape", async () => {
      given(signedIn(true));
      const response = await GET();
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const body = memoriesResponseSchema.parse(await response.json());
      expect(body.memories.map((m) => m.id)).toEqual([MINE_NEW, MINE_OLD]);
      expect(body.memories[1]).toEqual({
        id: MINE_OLD,
        category: "frequent_food",
        content: "Usual shake: Fairlife Core Power 26g, 1 bottle",
        created_at: "2026-10-01T08:00:00+00:00",
        updated_at: "2026-10-01T08:00:00+00:00",
      } satisfies Memory);
    });

    it("returns 500 without details on a database error", async () => {
      given(signedIn(true), { table: "user_memories", op: "select" });
      const response = await GET();
      expect(response.status).toBe(500);
      expect(await errorCode(response)).toBe("internal");
      expect(errorSpy).toHaveBeenCalledWith("GET /api/memories failed:", "Error: user_memories select failed: boom");
    });
  });

  describe("PATCH /:id", () => {
    it("changes the content (trimmed) and returns the Memory", async () => {
      given(signedIn(true));
      const response = await patch(MINE_OLD, { content: "  Usual shake: Fairlife Core Power 42g  " });
      expect(response.status).toBe(200);
      const memory = memorySchema.parse(await response.json());
      expect(memory).toMatchObject({ id: MINE_OLD, category: "frequent_food", content: "Usual shake: Fairlife Core Power 42g" });
      expect(db.rows("user_memories").find((r) => r.id === MINE_OLD)!.content).toBe("Usual shake: Fairlife Core Power 42g");
      theirsUnchanged();
    });

    it.each([
      ["someone else's memory", THEIRS],
      ["a deleted memory", MINE_DELETED],
      ["a memory that doesn't exist", MISSING],
      ["a malformed id", "not-a-uuid"],
    ])("returns 404 for %s and changes nothing", async (_, id) => {
      given(signedIn(true));
      const response = await patch(id, { content: "hacked" });
      expect(response.status).toBe(404);
      expect(await errorCode(response)).toBe("not_found");
      expect(db.rows("user_memories")).toEqual(ROWS);
    });

    it.each([
      ["empty content", { content: "   " }],
      ["content over 500 characters", { content: "x".repeat(501) }],
      ["no content", {}],
      ["content that isn't a string", { content: 42 }],
      ["a body that isn't JSON", "nope"],
    ])("returns 400 for %s", async (_, body) => {
      given(signedIn(true));
      const response = await patch(MINE_OLD, body);
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("validation_error");
      expect(db.rows("user_memories")).toEqual(ROWS);
    });

    it("uses the session user, never the body's", async () => {
      given(signedIn(true));
      const response = await patch(THEIRS, { content: "x", user_id: OTHER });
      expect(response.status).toBe(404);
      theirsUnchanged();
    });
  });

  describe("DELETE /:id", () => {
    it("soft-deletes the memory: 204, deleted_at set, gone from GET", async () => {
      given(signedIn(true));
      const response = await del(MINE_OLD);
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");

      const deleted = db.rows("user_memories").find((r) => r.id === MINE_OLD)!;
      expect(deleted.deleted_at).toEqual(expect.any(String));
      expect(deleted.content).toBe(ROWS[0]!.content); // kept so extraction won't re-learn it

      const list = memoriesResponseSchema.parse(await (await GET()).json());
      expect(list.memories.map((m) => m.id)).toEqual([MINE_NEW]);
      theirsUnchanged();
    });

    it.each([
      ["someone else's memory", THEIRS],
      ["an already-deleted memory", MINE_DELETED],
      ["a memory that doesn't exist", MISSING],
      ["a malformed id", "123"],
    ])("returns 404 for %s and changes nothing", async (_, id) => {
      given(signedIn(true));
      const response = await del(id);
      expect(response.status).toBe(404);
      expect(await errorCode(response)).toBe("not_found");
      expect(db.rows("user_memories")).toEqual(ROWS);
    });

    it("a second delete of the same memory is 404", async () => {
      given(signedIn(true));
      expect((await del(MINE_OLD)).status).toBe(204);
      expect((await del(MINE_OLD)).status).toBe(404);
    });
  });
});
