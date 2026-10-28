import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiErrorException } from "@/lib/api-error";
import { createFakeDb, fakeClient, type FakeDb } from "@/lib/database/__fixtures__/fake-db";
import { createAppDb, type MemoryDb } from "@/lib/database/__fixtures__/memory-supabase";
import { messagesPageSchema } from "@/lib/validation";
import { apiErrorSchema } from "@/lib/validation/errors";

// GET /api/messages and DELETE /api/messages/:id. Messages live in memory-supabase; meals (for card
// re-hydration) in B7's fake-db.

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const CONVERSATION = "33333333-3333-4333-8333-333333333333";
const MEAL_TABLES = new Set(["meals", "meal_items"]);

let mealDb: FakeDb;
let appDb: MemoryDb;
let session: string | null;

vi.mock("@/lib/auth/server", () => ({
  requireUser: async () => {
    if (!session) throw new ApiErrorException("unauthenticated");
    const meals = fakeClient(mealDb, { userId: session });
    const supabase = {
      from: (table: string) => (MEAL_TABLES.has(table) ? meals.from(table as never) : appDb.from(table)),
      rpc: meals.rpc,
    } as unknown as SupabaseClient;
    return { user: { id: session }, supabase };
  },
}));

const { GET } = await import("./route");
const { DELETE } = await import("./[id]/route");

const list = (query = "") => GET(new Request(`http://localhost/api/messages${query}`));
const remove = (id: string) =>
  DELETE(new Request(`http://localhost/api/messages/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id }) });

// Ids are chosen so that id order differs from insertion order, to prove the (created_at, id) cursor.
function uuidFor(n: number) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function message(n: number, createdAt: string, extra: Record<string, unknown> = {}) {
  return {
    id: uuidFor(n),
    conversation_id: CONVERSATION,
    user_id: A,
    client_message_id: null,
    role: n % 2 === 0 ? "assistant" : "user",
    content: `message ${n}`,
    cards: [],
    tool_payload: null,
    had_image: false,
    related_meal_id: null,
    status: "sent",
    created_at: createdAt,
    ...extra,
  };
}

const t = (second: number) => `2026-10-26T18:00:${String(second).padStart(2, "0")}.000000+00:00`;

function storedMeal(id: string) {
  const now = new Date().toISOString();
  mealDb.meals.push({
    id,
    user_id: A,
    name: "Eggs and Toast",
    consumed_at: now,
    created_at: now,
    updated_at: now,
    source_type: "text",
    total_calories: 235,
    total_protein_g: 15.6,
    total_carbs_g: 20,
    total_fat_g: 10,
    status: "active",
    deleted_at: null,
    version: 2,
  });
}

beforeEach(() => {
  session = A;
  mealDb = createFakeDb();
  appDb = createAppDb({
    messages: [
      message(1, t(1)),
      message(2, t(2)),
      // Same timestamp: ordered by id, so 5 sorts before 9 although 9 was inserted first.
      message(9, t(3)),
      message(5, t(3)),
      message(4, t(4)),
      message(7, t(5)),
      // Not part of the user's chat: another user's message, a tool row, and a deleted one.
      message(11, t(6), { user_id: B }),
      message(12, t(7), { role: "tool" }),
      message(13, t(8), { status: "deleted" }),
    ],
  });
});

async function page(query: string) {
  const response = await list(query);
  expect(response.status).toBe(200);
  return messagesPageSchema.parse(await response.json());
}

describe("GET /api/messages", () => {
  it("returns 401 without a session", async () => {
    session = null;
    expect((await list()).status).toBe(401);
  });

  it("pages newest first by (created_at, id), oldest → newest within each page", async () => {
    const first = await page("?limit=2");
    expect(first.messages.map((m) => m.text)).toEqual(["message 4", "message 7"]);
    expect(first.has_more).toBe(true);

    const second = await page(`?limit=2&before=${first.messages[0]!.id}`);
    expect(second.messages.map((m) => m.text)).toEqual(["message 5", "message 9"]);
    expect(second.has_more).toBe(true);

    const third = await page(`?limit=2&before=${second.messages[0]!.id}`);
    expect(third.messages.map((m) => m.text)).toEqual(["message 1", "message 2"]);
    expect(third.has_more).toBe(false);
  });

  it("returns everything when it fits, and only the user's own user/assistant messages", async () => {
    const all = await page("");
    expect(all.messages.map((m) => m.text)).toEqual(["message 1", "message 2", "message 5", "message 9", "message 4", "message 7"]);
    expect(all.has_more).toBe(false);
    expect(new Set(all.messages.map((m) => m.role))).toEqual(new Set(["user", "assistant"]));
  });

  it("404s for a cursor that isn't one of the user's messages, 400 for a malformed one", async () => {
    expect((await list(`?before=${uuidFor(11)}`)).status).toBe(404); // user B's
    expect((await list(`?before=${randomUUID()}`)).status).toBe(404);
    const bad = await list("?before=nope&limit=0");
    expect(bad.status).toBe(400);
    expect(apiErrorSchema.parse(await bad.json()).error.code).toBe("validation_error");
  });

  it("re-hydrates meal cards with the current meal, and null once the meal is deleted", async () => {
    const live = randomUUID();
    const gone = randomUUID();
    storedMeal(live);
    appDb = createAppDb({
      messages: [
        message(2, t(1), {
          cards: [
            { kind: "meal", meal_id: live, meal: null },
            { kind: "meal", meal_id: gone, meal: null },
          ],
        }),
      ],
    });
    const { messages } = await page("");
    const [liveCard, goneCard] = messages[0]!.cards;
    expect(liveCard).toMatchObject({ kind: "meal", meal_id: live, meal: { id: live, name: "Eggs and Toast", version: 2 } });
    expect(goneCard).toEqual({ kind: "meal", meal_id: gone, meal: null });
  });
});

describe("DELETE /api/messages/:id", () => {
  it("deletes the message only, leaving linked meals alone", async () => {
    const mealId = randomUUID();
    storedMeal(mealId);
    appDb = createAppDb({ messages: [message(2, t(1), { related_meal_id: mealId, cards: [{ kind: "meal", meal_id: mealId, meal: null }] })] });

    const response = await remove(uuidFor(2));
    expect(response.status).toBe(204);
    expect(appDb.rows("messages")).toHaveLength(0);
    expect(mealDb.meals.map((m) => m.id)).toEqual([mealId]);
  });

  it("404s for another user's message, an unknown id, or a malformed id", async () => {
    expect((await remove(uuidFor(11))).status).toBe(404);
    expect(appDb.rows("messages").some((row) => row.id === uuidFor(11))).toBe(true);
    expect((await remove(randomUUID())).status).toBe(404);
    expect((await remove("not-a-uuid")).status).toBe(404);
  });

  it("returns 401 without a session", async () => {
    session = null;
    expect((await remove(uuidFor(1))).status).toBe(401);
  });
});
