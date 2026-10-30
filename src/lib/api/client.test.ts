import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { createFixtures, errorFixtures, errorStatuses } from "@/mocks/fixtures";
import { createMockApi } from "@/mocks/server";
import type { ErrorCode } from "@/types/api";

describe("typed API transport", () => {
  const server = createMockApi({ seedCount: 0, aiDelay: () => 0 });
  const transport = vi.fn((path: string, init?: RequestInit) =>
    server.handle(new Request(`http://test${path}`, init)),
  );
  beforeEach(() => {
    server.reset();
    transport.mockClear();
    vi.stubEnv("NEXT_PUBLIC_USE_MOCKS", "0");
    vi.stubGlobal("fetch", transport);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends multipart data and reuses a chat draft on retry", async () => {
    const draft = api.createChatDraft({
      text: "2 eggs and toast",
      image: new Blob(["photo"], { type: "image/jpeg" }),
      timezone: "America/Los_Angeles",
    });
    const first = await api.sendChat(draft);
    const second = await api.sendChat(draft);
    expect(first.assistant_message.id).toBe(second.assistant_message.id);
    expect(first.user_message.had_image).toBe(true);
    expect(
      new Headers(transport.mock.calls[0][1]?.headers).has("Content-Type"),
    ).toBe(false);
    expect(first.user_message.client_message_id).toBe(draft.client_message_id);
  });

  it("keeps one idempotency key for each save action", async () => {
    const proposal = createFixtures().single;
    const action = api.createSaveAction({
      meals: [{ ...proposal, source_type: "text" }],
    });
    expect(action.idempotencyKey).toBe(proposal.proposal_id);
    const first = await api.saveMeals(action);
    const retried = await api.saveMeals(action);
    expect(retried.meals[0].id).toBe(first.meals[0].id);
    expect((await api.getDaily()).consumed.calories).toBe(320);
    const manual = api.createSaveAction({
      meals: [{ ...proposal, proposal_id: null, source_type: "manual" }],
    });
    expect(manual.idempotencyKey).not.toBe(proposal.proposal_id);
    const all = api.createSaveAction({
      meals: [
        { ...proposal, source_type: "text" },
        { ...proposal, source_type: "text" },
      ],
    });
    expect(all.idempotencyKey).not.toBe(proposal.proposal_id);
  });

  it.each(Object.keys(errorFixtures) as ErrorCode[])(
    "preserves the %s contract error",
    async (code) => {
      server.failNext(code);
      await expect(
        api.getMe({ redirectOnAuthError: false }),
      ).rejects.toMatchObject({
        name: "ApiClientError",
        status: errorStatuses[code],
        ...errorFixtures[code].error,
      });
    },
  );

  it("redirects authentication errors and still rejects the request", async () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign } });
    server.failNext("unauthenticated");
    await expect(api.getMe()).rejects.toMatchObject({
      code: "unauthenticated",
    });
    expect(assign).toHaveBeenLastCalledWith("/sign-in");
    server.failNext("not_approved");
    await expect(api.getMe()).rejects.toMatchObject({ code: "not_approved" });
    expect(assign).toHaveBeenLastCalledWith("/not-approved");
  });

  it.each([
    ["unauthenticated", "/sign-in"],
    ["not_approved", "/not-approved"],
  ] as const)(
    "does not reload %s errors on their existing destination",
    async (code, pathname) => {
      const assign = vi.fn();
      vi.stubGlobal("window", { location: { assign, pathname } });
      server.failNext(code);
      await expect(api.getMe()).rejects.toMatchObject({ code });
      expect(assign).not.toHaveBeenCalled();
    },
  );

  it("handles proxy HTML and network failures without leaking their content", async () => {
    transport.mockResolvedValueOnce(
      new Response("<html>private stack trace</html>", { status: 502 }),
    );
    await expect(api.getMe()).rejects.toMatchObject({
      code: "internal",
      retryable: true,
    });
    transport.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(api.getMe()).rejects.toMatchObject({
      code: "internal",
      retryable: true,
      status: 0,
    });
  });

  it("uses the local handler without calling fetch when mock mode is on", async () => {
    vi.stubEnv("NEXT_PUBLIC_USE_MOCKS", "1");
    expect((await api.getMe()).display_name).toBe("Ken");
    expect(transport).not.toHaveBeenCalled();
  });

  it("ignores both the mock env flag and a per-call override in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_USE_MOCKS", "1");
    expect(api.isMockMode()).toBe(false);
    await api.getMe();
    await api.getMe({ mock: true });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("downloads blobs and treats 204 responses as void", async () => {
    const memory = (await api.getMemories()).memories[0];
    expect(await api.deleteMemory(memory.id)).toBeUndefined();
    const data = await api.exportData("json", "account");
    expect(JSON.parse(await data.text())).toMatchObject({
      meals: [],
      memories: [],
    });
    expect(await api.deleteAccount()).toBeUndefined();
    await expect(
      api.getMe({ redirectOnAuthError: false }),
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("exercises every account wrapper and the full meal/message lifecycle", async () => {
    expect((await api.getMe()).approved).toBe(true);
    expect((await api.completeOnboarding()).onboarding_complete).toBe(true);
    expect((await api.getGoals())?.calories).toBe(2200);
    await api.putGoals({
      calories: 2400,
      protein_g: 160,
      carbs_g: 260,
      fat_g: 70,
    });
    expect((await api.getDaily()).targets?.calories).toBe(2400);
    expect(
      (
        await api.suggestGoals({
          age: 25,
          height_cm: 175,
          weight_kg: 75,
          sex: "male",
          activity: "moderate",
          goal: "maintain",
        })
      ).suggested.calories,
    ).toBeGreaterThan(0);
    await api.patchPreferences({ assistant_style: "detailed" });
    expect((await api.getPreferences()).assistant_style).toBe("detailed");
    const memory = (await api.getMemories()).memories[0];
    expect(
      (await api.patchMemory(memory.id, { content: "Updated usual shake" }))
        .content,
    ).toBe("Updated usual shake");
    const turn = await api.sendChat(api.createChatDraft({ text: "eggs" }));
    const proposal = turn.assistant_message.cards[0];
    if (proposal.kind !== "proposal") throw new Error("Expected proposal");
    const saved = await api.saveMeals(
      api.createSaveAction({
        meals: [{ ...proposal.proposal, source_type: "text" }],
      }),
    );
    const id = saved.meals[0].id;
    expect((await api.getMeal(id)).name).toBe("Eggs and toast");
    const updated = await api.updateMeal(id, {
      version: 1,
      name: "Updated meal",
    });
    expect(updated.meal.version).toBe(2);
    expect((await api.getMeals({ q: "Updated" })).meals).toHaveLength(1);
    expect((await api.deleteMeal(id)).daily_summary.consumed.calories).toBe(0);
    expect((await api.undoDelete(id)).daily_summary.consumed.calories).toBe(
      320,
    );
    const csv = await api.exportData("csv");
    expect(await csv.text()).toContain('"Updated meal"');
    await api.deleteMessage(turn.user_message.id);
    expect(
      (await api.getMessages()).messages.some(
        (message) => message.id === turn.user_message.id,
      ),
    ).toBe(false);
    expect((await api.getMeal(id)).id).toBe(id);
  });
});
