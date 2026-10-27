import { beforeEach, describe, expect, it } from "vitest";
import { createMockApi } from "./server";
import { createFixtures, errorFixtures } from "./fixtures";
import { apiErrorSchema } from "@/lib/validation/errors";
import {
  chatResponseSchema,
  messagesPageSchema,
  mealCardSchema,
} from "@/lib/validation/chat";
import { dailySummarySchema } from "@/lib/validation/goals";
import {
  mealProposalSchema,
  mealSchema,
  mealsPageSchema,
} from "@/lib/validation/meal";
import type {
  ChatResponse,
  DeleteMealResponse,
  Meal,
  MealsPage,
  MessagesPage,
  SaveMealsResponse,
  UpdateMealResponse,
} from "@/types/api";

describe("stateful mock API", () => {
  let time = new Date("2026-10-26T12:00:00Z");
  const server = createMockApi({
    seedCount: 0,
    aiDelay: () => 0,
    now: () => time,
  });
  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    key?: string,
  ): Promise<T> {
    const response = await server.handle(
      new Request(`http://test${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    if (!response.ok) throw await response.json();
    return response.status === 204 ? (undefined as T) : response.json();
  }
  function saveInput() {
    return { meals: [{ ...createFixtures(time).single, source_type: "text" }] };
  }
  async function save() {
    return call<SaveMealsResponse>(
      "POST",
      "/api/meals",
      saveInput(),
      crypto.randomUUID(),
    );
  }
  beforeEach(() => {
    time = new Date("2026-10-26T12:00:00Z");
    server.reset();
  });

  it("keeps every fixture compatible with H1's Zod schemas", () => {
    const f = createFixtures(time);
    for (const proposal of [f.single, ...f.three, f.photo, f.clarification])
      expect(mealProposalSchema.safeParse(proposal).success).toBe(true);
    expect(mealSchema.safeParse(f.autoSaved).success).toBe(true);
    expect(mealCardSchema.safeParse(f.deletedMessage.cards[0]).success).toBe(
      true,
    );
    for (const error of Object.values(errorFixtures))
      expect(apiErrorSchema.safeParse(error).success).toBe(true);
  });

  it("saves once on concurrent retries and updates daily totals and searchable history", async () => {
    const key = crypto.randomUUID(),
      body = saveInput();
    const [a, b] = await Promise.all([
      call<SaveMealsResponse>("POST", "/api/meals", body, key),
      call<SaveMealsResponse>("POST", "/api/meals", body, key),
    ]);
    expect(a.meals[0].id).toBe(b.meals[0].id);
    expect(dailySummarySchema.parse(a.daily_summary).consumed.calories).toBe(
      320,
    );
    const page = await call<MealsPage>("GET", "/api/meals?q=eggs");
    expect(mealsPageSchema.parse(page).meals).toHaveLength(1);
  });

  it("recalculates portions, detects stale edits, and updates both dates on a move", async () => {
    const meal = (await save()).meals[0];
    const items = meal.items.map((item) => ({
      ...item,
      grams: item.grams! * 2,
    }));
    const changed = await call<UpdateMealResponse>(
      "PATCH",
      `/api/meals/${meal.id}`,
      { version: meal.version, items, consumed_at: "2026-10-25T12:00:00Z" },
    );
    expect(changed.meal.totals.calories).toBe(640);
    expect(changed.meal.items[0].edited_by_user).toBe(true);
    expect(
      changed.daily_summaries.map((day) => day.consumed.calories).sort(),
    ).toEqual([0, 640]);
    await expect(
      call("PATCH", `/api/meals/${meal.id}`, { version: 1, name: "Stale" }),
    ).rejects.toMatchObject({ error: { code: "version_conflict" } });
  });

  it("removes deleted meals from totals immediately, permits undo, then expires it", async () => {
    const meal = (await save()).meals[0];
    const removed = await call<DeleteMealResponse>(
      "DELETE",
      `/api/meals/${meal.id}`,
    );
    expect(removed.daily_summary.consumed.calories).toBe(0);
    const undone = await call<{ meal: Meal }>(
      "POST",
      `/api/meals/${meal.id}/undo`,
    );
    expect(undone.meal.status).toBe("active");
    await call("DELETE", `/api/meals/${meal.id}`);
    time = new Date(time.getTime() + 10_001);
    await expect(
      call("POST", `/api/meals/${meal.id}/undo`),
    ).rejects.toMatchObject({ error: { code: "not_found" } });
  });

  it("pages meals and messages without gaps or duplicates", async () => {
    const seeded = createMockApi({
      seedCount: 70,
      aiDelay: () => 0,
      now: () => time,
    });
    const page = async <T>(path: string): Promise<T> =>
      (await seeded.handle(new Request(`http://test${path}`))).json();
    const first = await page<MealsPage>("/api/meals?limit=30");
    const second = await page<MealsPage>(
      `/api/meals?limit=30&cursor=${first.next_cursor}`,
    );
    expect(
      new Set([...first.meals, ...second.meals].map((meal) => meal.id)).size,
    ).toBe(60);
    const recent = messagesPageSchema.parse(
      await page<MessagesPage>("/api/messages?limit=30"),
    );
    const earlier = await page<MessagesPage>(
      `/api/messages?before=${recent.messages[0].id}&limit=30`,
    );
    expect(
      new Set(
        [...recent.messages, ...earlier.messages].map((message) => message.id),
      ).size,
    ).toBe(60);
    expect(
      earlier.messages.at(-1)!.created_at <= recent.messages[0].created_at,
    ).toBe(true);
  });

  it("replays concurrent chat turns, saves proposals and rehydrates deleted cards", async () => {
    const id = crypto.randomUUID();
    const chatRequest = () => {
      const form = new FormData();
      form.set("client_message_id", id);
      form.set("text", "2 eggs and toast");
      form.set("timezone", "UTC");
      return new Request("http://test/api/ai/chat", {
        method: "POST",
        body: form,
      });
    };
    const [a, b] = await Promise.all([
      server.handle(chatRequest()),
      server.handle(chatRequest()),
    ]);
    const response = chatResponseSchema.parse(await a.json());
    expect((await b.json()).assistant_message.id).toBe(
      response.assistant_message.id,
    );
    const card = response.assistant_message.cards[0];
    if (card.kind !== "proposal") throw new Error("Expected proposal");
    const saved = await call<SaveMealsResponse>(
      "POST",
      "/api/meals",
      { meals: [{ ...card.proposal, source_type: "text" }] },
      card.proposal.proposal_id,
    );
    let page = await call<MessagesPage>("GET", "/api/messages");
    expect(
      page.messages.find(
        (message) => message.id === response.assistant_message.id,
      )?.cards[0].kind,
    ).toBe("meal");
    await call("DELETE", `/api/meals/${saved.meals[0].id}`);
    page = await call<MessagesPage>("GET", "/api/messages");
    expect(
      page.messages.find(
        (message) => message.id === response.assistant_message.id,
      )?.cards[0],
    ).toMatchObject({ kind: "meal", meal: null });
  });

  it("auto-saves clear meals but keeps clarification proposals unsaved", async () => {
    await call("PATCH", "/api/preferences", { save_mode: "auto" });
    const chat = async (text: string): Promise<ChatResponse> => {
      const form = new FormData();
      form.set("client_message_id", crypto.randomUUID());
      form.set("text", text);
      form.set("timezone", "UTC");
      return (
        await server.handle(
          new Request("http://test/api/ai/chat", {
            method: "POST",
            body: form,
          }),
        )
      ).json();
    };
    expect((await chat("eggs")).assistant_message.cards[0].kind).toBe("meal");
    expect(
      (await chat("some chicken")).assistant_message.cards[0],
    ).toMatchObject({
      kind: "proposal",
      proposal: { needs_clarification: true },
    });
    expect(
      (await chat("should I eat pizza?")).assistant_message.cards,
    ).toHaveLength(0);
  });

  it("keeps goals, preferences, onboarding and memories consistent across reads", async () => {
    await call("PATCH", "/api/preferences", { timezone: "Pacific/Honolulu" });
    expect(await call("GET", "/api/preferences")).toMatchObject({
      timezone: "Pacific/Honolulu",
    });
    await call("PUT", "/api/goals", {
      calories: 2500,
      protein_g: 160,
      carbs_g: 270,
      fat_g: 70,
    });
    expect(await call("GET", "/api/nutrition/daily")).toMatchObject({
      targets: { calories: 2500 },
    });
    await call("POST", "/api/onboarding/complete");
    expect(await call("GET", "/api/me")).toMatchObject({
      onboarding_complete: true,
    });
    const result = await call<{ memories: { id: string }[] }>(
      "GET",
      "/api/memories",
    );
    await call("PATCH", `/api/memories/${result.memories[0].id}`, {
      content: "Updated shake",
    });
    await call("DELETE", `/api/memories/${result.memories[0].id}`);
    expect(await call("GET", "/api/memories")).toEqual({ memories: [] });
  });
});
