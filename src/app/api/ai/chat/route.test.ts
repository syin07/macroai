import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatResponse } from "@/types/api";
import { ApiErrorException } from "@/lib/api-error";
import {
  EGGS_AND_TOAST,
  VAGUE_BURGER,
  callTool,
  fakeProvider,
  food,
  lastToolOutputs,
  logged,
  meal,
  question,
  say,
  type FakeProvider,
} from "@/lib/ai/__fixtures__/chat-fakes";
import { CAP_REACHED_REPLY } from "@/lib/ai/chat";
import { createFakeDb, fakeClient, type FakeDb } from "@/lib/database/__fixtures__/fake-db";
import { createAppDb, type MemoryDb } from "@/lib/database/__fixtures__/memory-supabase";
import { chatResponseSchema, MAX_CHAT_BODY_BYTES, MAX_IMAGE_BYTES } from "@/lib/validation";
import { apiErrorSchema } from "@/lib/validation/errors";

// POST /api/ai/chat end to end with a scripted model: no network, no live model calls. Meals go
// through B7's real functions against its in-memory SQL-function fake (fake-db.ts); messages, prefs
// and ai_usage live in memory-supabase.

const A = "11111111-1111-4111-8111-111111111111";
const TZ = "America/Los_Angeles";

// Tables B7's fake implements (with its RLS emulation and SQL functions); everything else → appDb.
const MEAL_TABLES = new Set(["meals", "meal_items", "meal_revisions", "idempotency_keys", "nutrition_goals", "profiles"]);

let mealDb: FakeDb;
let appDb: MemoryDb;
let session: string | null;
let approved: boolean;
let provider: FakeProvider;

function userClient(userId: string): SupabaseClient {
  const meals = fakeClient(mealDb, { userId });
  return {
    from: (table: string) => (MEAL_TABLES.has(table) ? meals.from(table as never) : appDb.from(table)),
    rpc: meals.rpc,
  } as unknown as SupabaseClient;
}

vi.mock("@/lib/auth/server", () => ({
  requireUser: async () => {
    if (!session) throw new ApiErrorException("unauthenticated");
    if (!approved) throw new ApiErrorException("not_approved");
    return { user: { id: session }, supabase: userClient(session) };
  },
}));
vi.mock("@/lib/ai/providers", () => ({ getProvider: () => provider }));
// after() needs a live Next request scope; here its tasks are collected so tests can prove the
// response never waited on them, then run them by hand.
const afterTasks = vi.hoisted(() => [] as Array<() => unknown>);
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after: (task: () => unknown) => void afterTasks.push(task),
}));
async function runAfterTasks() {
  for (const task of afterTasks.splice(0)) await task();
}
vi.mock("@/lib/database/admin", () => ({
  createServiceRoleClient: () => {
    throw new Error("not configured");
  },
}));
// No USDA network: every food falls back to the model's estimate.
vi.mock("@/lib/nutrition/usda", async (original) => ({
  ...(await original<typeof import("@/lib/nutrition/usda")>()),
  searchFoods: vi.fn(async () => []),
  getFood: vi.fn(async () => null),
}));

const { POST } = await import("./route");

function given(saveMode: "confirm" | "auto" = "confirm") {
  mealDb = createFakeDb();
  mealDb.profiles.push({ id: A, timezone: TZ });
  appDb = createAppDb({
    account_preferences: [{ user_id: A, theme: "system", save_mode: saveMode, assistant_style: "casual" }],
  });
}

interface Send {
  id?: string;
  text?: string;
  image?: Blob;
  timezone?: string;
}

function send({ id = randomUUID(), text, image, timezone = TZ }: Send = {}) {
  const form = new FormData();
  form.set("client_message_id", id);
  form.set("timezone", timezone);
  if (text !== undefined) form.set("text", text);
  if (image) form.set("image", image, "meal.jpg");
  return POST(new Request("http://localhost/api/ai/chat", { method: "POST", body: form }));
}

async function ok(response: Response): Promise<ChatResponse> {
  expect(response.status).toBe(200);
  return chatResponseSchema.parse(await response.json());
}

async function errorOf(response: Response) {
  return apiErrorSchema.parse(await response.json()).error;
}

// The usual logging turn: propose, then a short reply.
const proposeThenSay = (description: string, reply = "Got it.") => [callTool("create_meal_proposal", { description }), say(reply)];

beforeEach(() => {
  session = A;
  approved = true;
  afterTasks.length = 0;
  given();
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/ai/chat — auth and validation", () => {
  it("returns 401 without a session and never calls the model", async () => {
    session = null;
    provider = fakeProvider([say("hi")]);
    const response = await send({ text: "hi" });
    expect(response.status).toBe(401);
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("returns 403 for a signed-in user who isn't approved, before reading the form or calling the model", async () => {
    approved = false;
    provider = fakeProvider([say("hi")]);
    const response = await send({ text: "hi" });
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe("not_approved");
    expect(provider.chat).not.toHaveBeenCalled();
    expect(appDb.rows("messages")).toHaveLength(0);
  });

  it("rejects a missing client_message_id, a bad time zone, and an empty message", async () => {
    provider = fakeProvider();
    const noId = new FormData();
    noId.set("text", "hi");
    noId.set("timezone", TZ);
    const responses = [
      await POST(new Request("http://localhost/api/ai/chat", { method: "POST", body: noId })),
      await send({ text: "hi", timezone: "Mars/Olympus" }),
      await send({ text: "   " }),
      await POST(new Request("http://localhost/api/ai/chat", { method: "POST", body: "{}" })),
    ];
    for (const response of responses) {
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe("validation_error");
    }
    expect(provider.chat).not.toHaveBeenCalled();
    expect(appDb.rows("messages")).toHaveLength(0);
  });
});

describe("POST /api/ai/chat — save modes", () => {
  it("confirm mode: returns an unsaved proposal card and saves nothing", async () => {
    provider = fakeProvider(proposeThenSay("2 eggs and toast", "About 235 kcal. Tap save if it looks right."), [
      logged(EGGS_AND_TOAST),
    ]);
    const id = randomUUID();
    const body = await ok(await send({ id, text: "2 eggs and toast" }));

    expect(body.user_message).toMatchObject({ role: "user", client_message_id: id, text: "2 eggs and toast", had_image: false, status: "sent" });
    expect(body.assistant_message.text).toBe("About 235 kcal. Tap save if it looks right.");
    expect(body.assistant_message.cards).toHaveLength(1);
    expect(body.assistant_message.cards[0]).toMatchObject({ kind: "proposal", state: "unsaved" });
    expect(body.daily_summary).toBeNull();
    expect(mealDb.meals).toHaveLength(0);

    // The model learned the proposal is unsaved.
    expect(lastToolOutputs(provider.chatInputs[1]!)[0]).toMatchObject({ proposals: [{ status: "unsaved_awaiting_user" }] });
    // Usage: two chat calls and one extraction call, all under ai/chat.
    expect(appDb.rows("ai_usage").map((row) => row.endpoint)).toEqual(["ai/chat", "ai/chat", "ai/chat"]);
  });

  it("auto mode: saves the meal, returns a saved meal card and today's summary", async () => {
    given("auto");
    provider = fakeProvider(proposeThenSay("2 eggs and toast", "Logged eggs and toast, 235 kcal."), [logged(EGGS_AND_TOAST)]);
    const body = await ok(await send({ text: "2 eggs and toast" }));

    expect(mealDb.meals).toHaveLength(1);
    const card = body.assistant_message.cards[0]!;
    expect(card.kind).toBe("meal");
    if (card.kind !== "meal") throw new Error("expected a meal card");
    expect(card.meal_id).toBe(mealDb.meals[0]!.id);
    expect(card.meal).toMatchObject({ name: "Eggs and Toast", source_type: "text", status: "active", version: 1 });
    expect(card.meal!.totals.calories).toBeCloseTo(235, 6);
    expect(body.daily_summary).toMatchObject({ timezone: TZ });
    expect(body.daily_summary!.consumed.calories).toBeCloseTo(235, 6);
    expect(body.daily_summary!.meals.map((m) => m.id)).toEqual([card.meal_id]);

    // The save used the proposal ID as its idempotency key, same as Ken's save button.
    expect(mealDb.idempotency_keys.map((k) => k.key)).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/)]);
    expect(lastToolOutputs(provider.chatInputs[1]!)[0]).toMatchObject({ proposals: [{ status: "saved", meal_id: card.meal_id }] });

    // The stored message links the meal and keeps no meal snapshot (cards are re-hydrated on read).
    const stored = appDb.rows("messages").find((row) => row.role === "assistant")!;
    expect(stored.related_meal_id).toBe(card.meal_id);
    expect(stored.cards).toEqual([{ kind: "meal", meal_id: card.meal_id, meal: null }]);
  });

  it("auto mode asks instead of saving when the FR-03 rule needs clarification", async () => {
    given("auto");
    provider = fakeProvider(proposeThenSay("a burger", "Where was the burger from?"), [logged(VAGUE_BURGER)]);
    const body = await ok(await send({ text: "had a burger" }));

    expect(mealDb.meals).toHaveLength(0);
    expect(body.assistant_message.cards).toHaveLength(1);
    expect(body.assistant_message.cards[0]).toMatchObject({ kind: "proposal", state: "unsaved", proposal: { needs_clarification: true } });
    expect(body.daily_summary).toBeNull();
    expect(lastToolOutputs(provider.chatInputs[1]!)[0]).toMatchObject({ proposals: [{ status: "needs_clarification" }] });
  });

  it("handles several meals in one message: three cards in confirm mode, three saves in auto mode", async () => {
    const three = logged(
      meal("Eggs and Toast", [food("Eggs", 155, 12.6, 100)], { time_phrase: "for breakfast" }),
      meal("Chicken and Rice", [food("Chicken", 250, 46, 150), food("Rice", 210, 4, 160)], { time_phrase: "lunch" }),
      meal("Pizza", [food("Pizza slice", 285, 12, 107)], { time_phrase: "dinner" }),
    );
    const text = "For breakfast I had eggs. Lunch was chicken and rice. Dinner was pizza.";

    provider = fakeProvider(proposeThenSay(text), [three]);
    const confirm = await ok(await send({ text }));
    expect(confirm.assistant_message.cards.map((c) => c.kind)).toEqual(["proposal", "proposal", "proposal"]);
    expect(new Set(confirm.assistant_message.cards.map((c) => (c.kind === "proposal" ? c.proposal.proposal_id : "")))).toHaveProperty("size", 3);
    expect(mealDb.meals).toHaveLength(0);

    given("auto");
    provider = fakeProvider(proposeThenSay(text), [structuredClone(three)]);
    const auto = await ok(await send({ text }));
    expect(auto.assistant_message.cards.map((c) => c.kind)).toEqual(["meal", "meal", "meal"]);
    expect(mealDb.meals.map((m) => m.name).sort()).toEqual(["Chicken and Rice", "Eggs and Toast", "Pizza"]);
  });

  it('"should I eat pizza?" saves nothing, even if the model tries to propose it', async () => {
    given("auto");
    provider = fakeProvider(proposeThenSay("pizza", "A slice is about 285 kcal; you have room for one."), [
      question("Hypothetical, not eaten yet."),
    ]);
    const body = await ok(await send({ text: "should I eat pizza?" }));

    expect(body.assistant_message.cards).toEqual([]);
    expect(body.daily_summary).toBeNull();
    expect(mealDb.meals).toHaveLength(0);
    expect(lastToolOutputs(provider.chatInputs[1]!)[0]).toMatchObject({ intent: "question", proposals: [] });
  });

  it("shows no saved card when the save fails, so nothing claims a save that didn't happen", async () => {
    given("auto");
    mealDb.failRpc = "save_meals";
    provider = fakeProvider(proposeThenSay("2 eggs and toast", "That didn't save, sorry."), [logged(EGGS_AND_TOAST)]);
    const body = await ok(await send({ text: "2 eggs and toast" }));

    expect(mealDb.meals).toHaveLength(0);
    expect(body.assistant_message.cards.some((c) => c.kind === "meal")).toBe(false);
    expect(body.daily_summary).toBeNull();
    expect(lastToolOutputs(provider.chatInputs[1]!)[0]).toMatchObject({ error: expect.any(String) });
  });
});

describe("POST /api/ai/chat — replay", () => {
  it("returns the original result for a repeated client_message_id without calling the model again", async () => {
    given("auto");
    provider = fakeProvider(proposeThenSay("2 eggs and toast", "Logged."), [logged(EGGS_AND_TOAST)]);
    const id = randomUUID();
    const first = await ok(await send({ id, text: "2 eggs and toast" }));
    const chatCalls = provider.chat.mock.calls.length;
    const usageRows = appDb.rows("ai_usage").length;

    const second = await ok(await send({ id, text: "2 eggs and toast" }));
    expect(provider.chat.mock.calls.length).toBe(chatCalls);
    expect(provider.extractMeal).toHaveBeenCalledTimes(1);
    expect(appDb.rows("ai_usage")).toHaveLength(usageRows);
    expect(appDb.rows("messages")).toHaveLength(2);
    expect(mealDb.meals).toHaveLength(1);

    expect(second.user_message).toEqual(first.user_message);
    expect(second.assistant_message.id).toBe(first.assistant_message.id);
    expect(second.assistant_message.text).toBe(first.assistant_message.text);
    expect(second.assistant_message.cards).toEqual(first.assistant_message.cards); // re-hydrated, same meal
    expect(second.daily_summary).toEqual(first.daily_summary);
  });

  it("replays even when the AI cap has been reached since", async () => {
    provider = fakeProvider([say("Hi!")]);
    const id = randomUUID();
    await ok(await send({ id, text: "hi" }));
    vi.stubEnv("AI_DAILY_CALL_CAP", "1");
    const again = await ok(await send({ id, text: "hi" }));
    expect(again.assistant_message.text).toBe("Hi!");
  });

  it("answers 503 retryable while the first attempt is still running", async () => {
    const id = randomUUID();
    appDb = createAppDb({
      account_preferences: [{ user_id: A, theme: "system", save_mode: "confirm", assistant_style: "casual" }],
      messages: [
        { id: randomUUID(), conversation_id: randomUUID(), user_id: A, client_message_id: id, role: "user", content: "hi", cards: [], had_image: false, status: "pending", created_at: new Date().toISOString() },
      ],
    });
    provider = fakeProvider([say("Hi!")]);
    const response = await send({ id, text: "hi" });
    expect(response.status).toBe(503);
    expect(await errorOf(response)).toMatchObject({ code: "ai_unavailable", retryable: true });
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("re-runs a message whose first attempt failed, reusing the stored user message", async () => {
    provider = fakeProvider();
    provider.chat.mockRejectedValueOnce(new Error("overloaded"));
    const id = randomUUID();
    const failed = await send({ id, text: "hi" });
    expect(failed.status).toBe(503);
    expect(appDb.rows("messages")).toMatchObject([{ role: "user", status: "error" }]);

    const retried = await ok(await send({ id, text: "hi" }));
    expect(retried.user_message.status).toBe("sent");
    expect(appDb.rows("messages").filter((row) => row.role === "user")).toHaveLength(1);
    expect(appDb.rows("messages")).toHaveLength(2);
  });
});

describe("POST /api/ai/chat — AI cap", () => {
  it("returns 429 before any model call once today's calls reach the cap", async () => {
    vi.stubEnv("AI_DAILY_CALL_CAP", "2");
    const now = new Date().toISOString();
    appDb = createAppDb({
      account_preferences: [{ user_id: A, theme: "system", save_mode: "confirm", assistant_style: "casual" }],
      ai_usage: [
        { user_id: A, endpoint: "ai/chat", model: "x", created_at: now },
        { user_id: A, endpoint: "ai/chat", model: "x", created_at: now },
      ],
    });
    provider = fakeProvider([say("hi")]);
    const response = await send({ text: "2 eggs" });

    expect(response.status).toBe(429);
    expect((await errorOf(response)).code).toBe("ai_cap_reached");
    expect(provider.chat).not.toHaveBeenCalled();
    expect(provider.extractMeal).not.toHaveBeenCalled();
    expect(appDb.rows("messages")).toHaveLength(0);
  });

  it("mid-turn: keeps the proposal already made and replies with the limit message, not an error", async () => {
    // Cap 2: the first chat call and the extraction fit; the second chat call doesn't.
    vi.stubEnv("AI_DAILY_CALL_CAP", "2");
    provider = fakeProvider(proposeThenSay("2 eggs and toast", "never sent"), [logged(EGGS_AND_TOAST)]);
    const body = await ok(await send({ text: "2 eggs and toast" }));

    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(provider.extractMeal).toHaveBeenCalledTimes(1);
    expect(body.assistant_message.cards).toMatchObject([{ kind: "proposal", state: "unsaved" }]);
    expect(body.assistant_message.text).toContain(CAP_REACHED_REPLY);
    expect(body.user_message.status).toBe("sent");
    expect(appDb.rows("ai_usage")).toHaveLength(2);
    // The memory pass isn't even scheduled.
    expect(afterTasks).toHaveLength(0);
  });

  it("mid-turn in auto mode: the saved meal stays saved and is reported", async () => {
    vi.stubEnv("AI_DAILY_CALL_CAP", "2");
    given("auto");
    provider = fakeProvider(proposeThenSay("2 eggs and toast", "never sent"), [logged(EGGS_AND_TOAST)]);
    const body = await ok(await send({ text: "2 eggs and toast" }));

    expect(mealDb.meals).toHaveLength(1);
    expect(body.assistant_message.cards).toMatchObject([{ kind: "meal" }]);
    expect(body.assistant_message.text).toBe(`Saved: Eggs and Toast (235 kcal).\n${CAP_REACHED_REPLY}`);
    expect(body.daily_summary).not.toBeNull();
  });

  it("checks before the extraction call too: at the cap the extraction never runs", async () => {
    vi.stubEnv("AI_DAILY_CALL_CAP", "2");
    provider = fakeProvider(
      [callTool("search_nutrition_foods", { query: "egg" }), callTool("create_meal_proposal", { description: "2 eggs" }), say("never sent")],
      [logged(EGGS_AND_TOAST)],
    );
    const body = await ok(await send({ text: "2 eggs" }));

    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(provider.extractMeal).not.toHaveBeenCalled();
    expect(body.assistant_message).toMatchObject({ text: CAP_REACHED_REPLY, cards: [] });
    expect(appDb.rows("ai_usage")).toHaveLength(2);
  });

  it("a turn never ends up over the cap, however many tool steps the model wants", async () => {
    vi.stubEnv("AI_DAILY_CALL_CAP", "3");
    provider = fakeProvider(Array.from({ length: 10 }, () => callTool("search_nutrition_foods", { query: "egg" })));
    await ok(await send({ text: "tell me about eggs" }));
    expect(provider.chat).toHaveBeenCalledTimes(3);
    expect(appDb.rows("ai_usage")).toHaveLength(3);
  });

  it("the memory pass skips silently rather than take the day's last call", async () => {
    vi.stubEnv("AI_DAILY_CALL_CAP", "2");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    provider = fakeProvider([say("Noted."), callTool("propose_memory", { has_memory: false })]);
    await ok(await send({ text: "my usual shake is Fairlife Core Power 26g" }));
    expect(afterTasks).toHaveLength(1);

    await runAfterTasks();
    expect(provider.chat).toHaveBeenCalledTimes(1); // 1 used, 1 left: the memory pass leaves it
    expect(appDb.rows("ai_usage").map((row) => row.endpoint)).toEqual(["ai/chat"]);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe("POST /api/ai/chat — request size", () => {
  // A body that never ends, counting how much of it was read.
  function endlessBody(chunkSize = 64 * 1024) {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunkSize;
        controller.enqueue(new Uint8Array(chunkSize));
      },
    });
    return { stream, pulled: () => pulled };
  }

  const multipart = { "content-type": "multipart/form-data; boundary=x" };

  it("refuses a declared Content-Length over the limit with 413 before reading the body", async () => {
    provider = fakeProvider([say("hi")]);
    const body = endlessBody();
    const request = new Request("http://localhost/api/ai/chat", {
      method: "POST",
      headers: { ...multipart, "content-length": String(MAX_CHAT_BODY_BYTES + 1) },
      body: body.stream,
      duplex: "half",
    } as RequestInit);
    const response = await POST(request);
    expect(response.status).toBe(413);
    expect((await errorOf(response)).code).toBe("payload_too_large");
    expect(body.pulled()).toBeLessThanOrEqual(64 * 1024); // at most the stream's own first pull
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("stops reading a streamed body at the limit and answers 413", async () => {
    provider = fakeProvider([say("hi")]);
    const body = endlessBody();
    const request = new Request("http://localhost/api/ai/chat", {
      method: "POST",
      headers: multipart,
      body: body.stream,
      duplex: "half",
    } as RequestInit);
    const response = await POST(request);
    expect(response.status).toBe(413);
    expect((await errorOf(response)).code).toBe("payload_too_large");
    // Read up to the limit plus a chunk or two of stream buffering, never the (infinite) rest.
    expect(body.pulled()).toBeLessThan(MAX_CHAT_BODY_BYTES + 4 * 64 * 1024);
    expect(appDb.rows("messages")).toHaveLength(0);
  });

  it("accepts a 1.5 MB image with a full caption inside the body limit", async () => {
    provider = fakeProvider([say("Nice.")]);
    const bytes = new Uint8Array(MAX_IMAGE_BYTES);
    bytes.set([0xff, 0xd8, 0xff]);
    const response = await send({ text: "é".repeat(2000), image: new Blob([bytes], { type: "image/jpeg" }) });
    expect(response.status).toBe(200);
  });
});

describe("POST /api/ai/chat — images", () => {
  const MARKER = "IMG-BYTES-MUST-NOT-PERSIST";
  const jpeg = (size?: number) => {
    const bytes = new Uint8Array(size ?? 64);
    bytes.set([0xff, 0xd8, 0xff]);
    bytes.set(new TextEncoder().encode(MARKER), 3);
    return new Blob([bytes], { type: "image/jpeg" });
  };

  it("rejects an image over 1.5 MB with 413 before the model is called", async () => {
    provider = fakeProvider([say("hi")]);
    const response = await send({ text: "lunch", image: jpeg(1.5 * 1024 * 1024 + 1) });
    expect(response.status).toBe(413);
    expect((await errorOf(response)).code).toBe("payload_too_large");
    expect(provider.chat).not.toHaveBeenCalled();
    expect(appDb.rows("messages")).toHaveLength(0);
  });

  it("rejects a type other than JPEG, PNG, or WebP with 400", async () => {
    provider = fakeProvider([say("hi")]);
    const response = await send({ image: new Blob([new Uint8Array(10)], { type: "image/gif" }) });
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({ code: "validation_error", fields: { image: expect.any(String) } });
  });

  it("passes the bytes to extraction only and stores nothing but had_image", async () => {
    given("auto");
    provider = fakeProvider(proposeThenSay("the meal in the photo"), [logged(EGGS_AND_TOAST)]);
    const body = await ok(await send({ image: jpeg() }));

    expect(body.user_message).toMatchObject({ had_image: true, text: "" });
    // Extraction got the exact bytes.
    const sent = provider.extractInputs[0]!.image!;
    expect(sent.mediaType).toBe("image/jpeg");
    expect(new TextDecoder().decode(sent.bytes.slice(3, 3 + MARKER.length))).toBe(MARKER);
    // The chat model only saw a marker, never the bytes.
    expect(JSON.stringify(provider.chatInputs)).not.toContain(MARKER);
    expect(provider.chatInputs[0]!.messages.at(-1)).toEqual({ role: "user", text: "[photo attached]" });
    // A photo meal is saved as source_type "photo".
    expect(mealDb.meals[0]!.source_type).toBe("photo");
  });

  it("rejects a file whose bytes aren't JPEG, PNG, or WebP, whatever its declared type", async () => {
    provider = fakeProvider([say("hi")]);
    const fakes = [
      new Blob([new TextEncoder().encode("GIF89a....")], { type: "image/jpeg" }),
      new Blob([new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>")], { type: "image/png" }),
      new Blob([new TextEncoder().encode("%PDF-1.7")], { type: "image/webp" }),
    ];
    for (const image of fakes) {
      const response = await send({ text: "lunch", image });
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toMatchObject({ code: "validation_error", fields: { image: "Image must be JPEG, PNG, or WebP" } });
    }
    expect(provider.chat).not.toHaveBeenCalled();
    expect(appDb.rows("messages")).toHaveLength(0);
  });

  it("tells the model the real format when the declared type is a different allowed one", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
    provider = fakeProvider(proposeThenSay("the meal in the photo"), [logged(EGGS_AND_TOAST)]);
    await ok(await send({ image: new Blob([png], { type: "image/jpeg" }) }));
    expect(provider.extractInputs[0]!.image!.mediaType).toBe("image/png");
  });

  it("sends the photo and the user's caption to one extraction call", async () => {
    provider = fakeProvider(proposeThenSay("chicken tenders and a dip"), [logged(EGGS_AND_TOAST)]);
    await ok(await send({ text: "fried, with ranch", image: jpeg() }));

    expect(provider.extractMeal).toHaveBeenCalledTimes(1);
    const [input] = provider.extractInputs;
    expect(input!.image).toBeDefined();
    // The caption word for word, plus the model's description where it adds something.
    expect(input!.text).toBe("fried, with ranch\nchicken tenders and a dip");
  });

  it("a text-only message's extraction gets the model's description unchanged", async () => {
    provider = fakeProvider(proposeThenSay("2 eggs and toast"), [logged(EGGS_AND_TOAST)]);
    await ok(await send({ text: "had 2 eggs and toast for breakfast" }));
    expect(provider.extractInputs[0]).toMatchObject({ text: "2 eggs and toast", image: undefined });
  });

  it("an unrecognizable photo gives no card and the model's short explanation reaches the chat model", async () => {
    const explanation = "I can't make out the food in this photo. Could you describe it?";
    provider = fakeProvider(proposeThenSay("the meal in the photo", explanation), [{ intent: "other", meals: [], explanation }]);
    const body = await ok(await send({ image: jpeg() }));

    expect(body.assistant_message).toMatchObject({ text: explanation, cards: [] });
    expect(lastToolOutputs(provider.chatInputs[1]!)[0]).toMatchObject({ proposals: [], explanation, saved: false });
    expect(mealDb.meals).toHaveLength(0);
  });

  describe("never stores or logs the image (PRD FR-15)", () => {
    const CONSOLE = ["log", "info", "warn", "error", "debug", "trace"] as const;
    let spies: Array<ReturnType<typeof vi.spyOn>>;
    beforeEach(() => {
      spies = CONSOLE.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    });
    afterEach(() => spies.forEach((spy) => spy.mockRestore()));

    // A photo whose bytes carry a marker, and every form they could leak in: raw, as text, base64
    // of the whole file (what providers send), and base64 of the marker at each alignment.
    const photo = jpeg(4096);
    const leakForms = async () => {
      const bytes = new Uint8Array(await photo.arrayBuffer());
      const base64 = Buffer.from(bytes).toString("base64");
      const markerBase64 = [0, 1, 2].map((shift) => Buffer.from(`${"x".repeat(shift)}${MARKER}`).toString("base64").slice(4, 24));
      return [MARKER, base64, base64.slice(0, 40), base64.slice(100, 160), ...markerBase64];
    };

    const stored = () =>
      JSON.stringify({
        messages: appDb.rows("messages"),
        conversations: appDb.rows("conversations"),
        ai_usage: appDb.rows("ai_usage"),
        user_memories: appDb.rows("user_memories"),
        memory_candidates: appDb.rows("memory_candidates"),
        mealDb,
      });
    const logLines = () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls));

    it("on a successful photo turn, including the memory pass", async () => {
      given("auto");
      provider = fakeProvider(proposeThenSay("the meal in the photo"), [logged(EGGS_AND_TOAST)]);
      await ok(await send({ text: "lunch", image: photo }));
      await runAfterTasks();

      expect(mealDb.meals).toHaveLength(1);
      for (const form of await leakForms()) {
        expect(stored()).not.toContain(form);
        expect(logLines()).not.toContain(form);
      }
    });

    it("when the extraction call fails with an error that echoes the request", async () => {
      provider = fakeProvider(proposeThenSay("the meal in the photo"));
      const base64 = Buffer.from(new Uint8Array(await photo.arrayBuffer())).toString("base64");
      provider.extractMeal.mockRejectedValue(Object.assign(new Error(`400 bad image: data:image/jpeg;base64,${base64}`), { status: 400 }));
      await ok(await send({ image: photo }));

      provider = fakeProvider();
      provider.chat.mockRejectedValue(new Error(`500 while sending ${base64}`));
      expect((await send({ image: photo })).status).toBe(503);

      expect(spies.some((spy) => spy.mock.calls.length > 0)).toBe(true); // failures were logged, by name
      for (const form of await leakForms()) {
        expect(stored()).not.toContain(form);
        expect(logLines()).not.toContain(form);
      }
    });
  });
});

describe("POST /api/ai/chat — failures", () => {
  it("returns 503 and marks the user message as error when the model is down", async () => {
    provider = fakeProvider();
    provider.chat.mockRejectedValue(new Error("connection reset"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await send({ text: "2 eggs and toast" });

    expect(response.status).toBe(503);
    expect(await errorOf(response)).toMatchObject({ code: "ai_unavailable", retryable: true });
    expect(appDb.rows("messages")).toMatchObject([{ role: "user", status: "error" }]);
    // The log line names the error, never the meal text.
    expect(JSON.stringify(errors.mock.calls)).not.toContain("eggs");
    errors.mockRestore();
  });
});

describe("POST /api/ai/chat — memories (B13)", () => {
  const SHAKE = "Usual shake: Fairlife Core Power 26g, 1 bottle";
  const memoryRow = (content: string, extra: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    user_id: A,
    category: "frequent_food",
    content,
    source_message_id: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    deleted_at: null,
    ...extra,
  });
  const withMemories = (...rows: Array<ReturnType<typeof memoryRow>>) => {
    appDb = createAppDb({
      account_preferences: [{ user_id: A, theme: "system", save_mode: "confirm", assistant_style: "casual" }],
      user_memories: rows,
    });
  };

  it("puts the retrieved memories in the context block, never deleted ones or someone else's", async () => {
    withMemories(
      memoryRow(SHAKE),
      memoryRow("Usual shake is a chocolate one", { deleted_at: "2026-10-02T00:00:00.000Z" }),
      memoryRow("Usual shake: B's vanilla shake", { user_id: "22222222-2222-4222-8222-222222222222" }),
      memoryRow("Keep answers short", { category: "response_style" }),
    );
    provider = fakeProvider([say("Logged-ish.")]);
    await ok(await send({ text: "had my usual shake" }));

    const context = provider.chatInputs[0]!.context!;
    expect(context).toContain(`- ${SHAKE}`);
    expect(context).toContain("- Keep answers short");
    expect(context).not.toContain("chocolate");
    expect(context).not.toContain("vanilla");
  });

  it("still answers when memories can't be read", async () => {
    appDb = createAppDb(
      { account_preferences: [{ user_id: A, theme: "system", save_mode: "confirm", assistant_style: "casual" }] },
      { table: "user_memories", op: "select" },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    provider = fakeProvider([say("Hi!")]);
    const body = await ok(await send({ text: "hi" }));
    expect(body.assistant_message.text).toBe("Hi!");
    vi.mocked(console.error).mockRestore();
  });

  it("runs the memory second pass after the response, on the same provider, and saves an explicit statement", async () => {
    const text = "remember my usual shake is Fairlife Core Power 26g";
    provider = fakeProvider([
      say("Noted."),
      // The memory pass's call: one propose_memory tool call quoting the user.
      callTool("propose_memory", {
        has_memory: true,
        category: "frequent_food",
        content: SHAKE,
        explicit: true,
        evidence: "my usual shake is Fairlife Core Power 26g",
        updates: null,
      }),
    ]);
    const body = await ok(await send({ text }));

    // The response went out with one model call and nothing saved yet: the pass is deferred.
    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(afterTasks).toHaveLength(1);
    expect(appDb.rows("user_memories")).toHaveLength(0);

    await runAfterTasks();
    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(provider.chatInputs[1]!.tools.map((t) => t.name)).toEqual(["propose_memory"]);
    expect(appDb.rows("user_memories")).toMatchObject([
      { user_id: A, content: SHAKE, source_message_id: body.user_message.id, deleted_at: null },
    ]);
    expect(appDb.rows("ai_usage").map((row) => row.endpoint)).toEqual(["ai/chat", "ai/memory"]);
  });

  it("a failing memory pass can't fail the response or throw after it", async () => {
    provider = fakeProvider([say("Hi!")]);
    const body = await ok(await send({ text: "my usual shake is Fairlife" }));
    expect(body.assistant_message.text).toBe("Hi!");

    provider.chat.mockRejectedValue(new Error("overloaded"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runAfterTasks()).resolves.toBeUndefined();
    expect(appDb.rows("user_memories")).toHaveLength(0);
    vi.mocked(console.error).mockRestore();
  });

  it("save_user_memory saves only what the user said, dedups, and skips the second pass", async () => {
    const text = "please remember my usual shake is Fairlife Core Power 26g";
    const args = { category: "frequent_food", content: SHAKE, evidence: "my usual shake is Fairlife Core Power 26g" };
    provider = fakeProvider([callTool("save_user_memory", args), say("I'll remember that.")]);
    const body = await ok(await send({ text }));

    expect(lastToolOutputs(provider.chatInputs[1]!)[0]).toMatchObject({ status: "saved" });
    expect(appDb.rows("user_memories")).toMatchObject([{ content: SHAKE, source_message_id: body.user_message.id }]);
    expect(afterTasks).toHaveLength(0);

    // The same fact again → the existing memory, no second row.
    provider = fakeProvider([callTool("save_user_memory", args), say("Already have it.")]);
    await ok(await send({ text }));
    expect(lastToolOutputs(provider.chatInputs[1]!)[0]).toMatchObject({ status: "already_saved" });
    expect(appDb.rows("user_memories")).toHaveLength(1);
  });

  it("save_user_memory refuses a memory the user didn't state in this message", async () => {
    provider = fakeProvider([
      callTool("save_user_memory", { category: "dietary", content: "User is vegetarian", evidence: "I am vegetarian" }),
      say("Okay."),
    ]);
    await ok(await send({ text: "had a salad" }));
    expect(lastToolOutputs(provider.chatInputs[1]!)[0]).toMatchObject({ error: expect.stringContaining("Not saved") });
    expect(appDb.rows("user_memories")).toHaveLength(0);
  });

  it("delete_user_memory soft-deletes the user's memory, and only theirs", async () => {
    const mine = memoryRow(SHAKE);
    const theirs = memoryRow("Usual shake: vanilla", { user_id: "22222222-2222-4222-8222-222222222222" });
    withMemories(mine, theirs);
    provider = fakeProvider([
      callTool("delete_user_memory", { memory_id: mine.id }),
      callTool("delete_user_memory", { memory_id: theirs.id }),
      say("Forgotten."),
    ]);
    await ok(await send({ text: "forget my usual shake" }));

    expect(lastToolOutputs(provider.chatInputs[1]!)[0]).toEqual({ status: "deleted" });
    expect(lastToolOutputs(provider.chatInputs[2]!)[0]).toMatchObject({ error: expect.any(String) });
    const rows = appDb.rows("user_memories");
    expect(rows.find((row) => row.id === mine.id)!.deleted_at).toEqual(expect.any(String));
    expect(rows.find((row) => row.id === theirs.id)!.deleted_at).toBeNull();
  });
});
