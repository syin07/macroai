import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { Meal, MealProposal } from "@/types/api";
import { ApiErrorException } from "@/lib/api-error";
import { callTool, fakeProvider, say } from "./__fixtures__/chat-fakes";
import { CAP_REACHED_REPLY, MAX_TOOL_STEPS, capReachedText, fallbackText, runChatTurn } from "./chat";
import { newTurnState, type MealStore, type ToolContext } from "./tools";

const noCap = async () => undefined;

// A cap check that allows `allowed` model calls, then throws ai_cap_reached on every later check.
function capAfter(allowed: number) {
  let checks = 0;
  return vi.fn(async () => {
    if (++checks > allowed) throw new ApiErrorException("ai_cap_reached");
  });
}

const chat ={ system: "SYSTEM", context: "CONTEXT", messages: [{ role: "user" as const, text: "hi" }] };

const proposal: MealProposal = {
  proposal_id: randomUUID(),
  name: "Eggs",
  consumed_at: "2026-10-26T08:00:00-07:00",
  items: [],
  totals: { calories: 155, protein_g: 12.6, carbs_g: 1.1, fat_g: 10.6 },
  needs_clarification: false,
  clarification_question: null,
};

function meals(): MealStore {
  return {
    saveProposal: vi.fn(async (p: MealProposal): Promise<Meal> => ({
      id: randomUUID(),
      name: p.name,
      consumed_at: p.consumed_at,
      created_at: p.consumed_at,
      updated_at: p.consumed_at,
      source_type: "text",
      items: [],
      totals: p.totals,
      status: "active",
      version: 1,
    })),
    getMeal: vi.fn(),
    getMeals: vi.fn(),
    updateMeal: vi.fn(),
    deleteMeal: vi.fn(),
    dailySummary: vi.fn(),
    recentMeals: vi.fn(async () => []),
    searchHistory: vi.fn(),
    lastMatching: vi.fn(),
  };
}

function tools(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: "u",
    supabase: {} as SupabaseClient,
    now: new Date(),
    timezone: "UTC",
    saveMode: "auto",
    analyze: vi.fn(async () => ({ intent: "log_meal" as const, proposals: [proposal], explanation: null, model: "m", promptVersion: "v" })),
    lookup: { searchFoods: vi.fn(async () => []), getFood: vi.fn(async () => null) },
    meals: meals(),
    memory: null,
    priorProposals: new Map(),
    ...overrides,
  };
}

describe("runChatTurn", () => {
  it("sends the cached system prompt and per-request context separately, with the offered tools", async () => {
    const provider = fakeProvider([say("Hey!")]);
    const result = await runChatTurn(chat, tools({ meals: null }), { provider, checkCap: noCap, recordUsage: vi.fn() });
    expect(result.text).toBe("Hey!");
    const input = provider.chatInputs[0]!;
    expect(input.system).toBe("SYSTEM");
    expect(input.context).toBe("CONTEXT");
    expect(input.tools.map((t) => t.name)).not.toContain("save_meal");
  });

  it("runs tools between model calls, replays provider content, and records usage for every call", async () => {
    const thinking = [{ type: "thinking", thinking: "", signature: "sig" }];
    const provider = fakeProvider([
      { ...callTool("create_meal_proposal", { description: "2 eggs" }), providerContent: thinking },
      say("Logged 2 eggs."),
    ]);
    const recordUsage = vi.fn(async () => {});
    const result = await runChatTurn(chat, tools(), { provider, checkCap: noCap, recordUsage });

    expect(result.text).toBe("Logged 2 eggs.");
    expect(result.state.cards).toMatchObject([{ kind: "meal" }]);
    const second = provider.chatInputs[1]!;
    expect(second.messages[1]).toMatchObject({ role: "assistant", providerContent: thinking });
    expect(second.messages[2]).toMatchObject({ role: "tool", results: [{ name: "create_meal_proposal" }] });
    expect(recordUsage).toHaveBeenCalledTimes(2);
  });

  it(`stops after ${MAX_TOOL_STEPS} model calls and doesn't run tool calls from the last one`, async () => {
    const loop = Array.from({ length: 10 }, () => callTool("search_nutrition_foods", { query: "egg" }));
    const provider = fakeProvider(loop);
    const ctx = tools();
    const result = await runChatTurn(chat, ctx, { provider, checkCap: noCap, recordUsage: vi.fn() });
    expect(provider.chat).toHaveBeenCalledTimes(MAX_TOOL_STEPS);
    expect(ctx.lookup.searchFoods).toHaveBeenCalledTimes(MAX_TOOL_STEPS - 1);
    expect(result.text).toBe("Sorry, I couldn't finish that. Please try again.");
  });

  it("throws ai_unavailable when the model fails before anything happened", async () => {
    const provider = fakeProvider();
    provider.chat.mockRejectedValue(new Error("503"));
    await expect(runChatTurn(chat, tools(), { provider, checkCap: noCap, recordUsage: vi.fn() })).rejects.toMatchObject({
      code: "ai_unavailable",
    } satisfies Partial<ApiErrorException>);
  });

  it("still reports a meal saved before the model failed, so a retry can't save it twice", async () => {
    const provider = fakeProvider([callTool("create_meal_proposal", { description: "2 eggs" })]);
    provider.chat.mockImplementationOnce(provider.chat.getMockImplementation()!).mockRejectedValueOnce(new Error("timeout"));
    const result = await runChatTurn(chat, tools(), { provider, checkCap: noCap, recordUsage: vi.fn() });
    expect(result.text).toBe("Saved: Eggs (155 kcal).");
    expect(result.state.mealChanged).toBe(true);
  });

  it("keeps the answer when recording usage fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const provider = fakeProvider([say("Hi")]);
    const result = await runChatTurn(chat, tools(), { provider, checkCap: noCap, recordUsage: vi.fn(async () => Promise.reject(new Error("db"))) });
    expect(result.text).toBe("Hi");
    errors.mockRestore();
  });
});

describe("runChatTurn — daily AI cap", () => {
  it("checks the cap before every model call", async () => {
    const provider = fakeProvider([callTool("search_nutrition_foods", { query: "egg" }), say("Eggs are great.")]);
    const checkCap = vi.fn(noCap);
    await runChatTurn(chat, tools(), { provider, checkCap, recordUsage: vi.fn() });
    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(checkCap).toHaveBeenCalledTimes(2);
    // Each check ran before its call.
    expect(checkCap.mock.invocationCallOrder[1]).toBeLessThan(provider.chat.mock.invocationCallOrder[1]!);
  });

  it("throws ai_cap_reached (429) when the cap is hit before the first call", async () => {
    const provider = fakeProvider([say("hi")]);
    await expect(runChatTurn(chat, tools(), { provider, checkCap: capAfter(0), recordUsage: vi.fn() })).rejects.toMatchObject({
      code: "ai_cap_reached",
    });
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("mid-turn: keeps the meal already saved and ends with the limit message instead of failing", async () => {
    const provider = fakeProvider([callTool("create_meal_proposal", { description: "2 eggs" }), say("never sent")]);
    const recordUsage = vi.fn(async () => {});
    const result = await runChatTurn(chat, tools(), { provider, checkCap: capAfter(1), recordUsage });

    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(result.capReached).toBe(true);
    expect(result.state.cards).toMatchObject([{ kind: "meal" }]);
    expect(result.state.mealChanged).toBe(true);
    expect(result.text).toBe(`Saved: Eggs (155 kcal).\n${CAP_REACHED_REPLY}`);
  });

  it("mid-turn: keeps an unsaved proposal card in confirm mode", async () => {
    const provider = fakeProvider([callTool("create_meal_proposal", { description: "2 eggs" })]);
    const result = await runChatTurn(chat, tools({ saveMode: "confirm" }), { provider, checkCap: capAfter(1), recordUsage: vi.fn() });
    expect(result.state.cards).toMatchObject([{ kind: "proposal", state: "unsaved" }]);
    expect(result.text).toBe(`Eggs: about 155 kcal. Save it if it looks right.\n${CAP_REACHED_REPLY}`);
  });

  it("mid-turn with nothing done yet still answers (no 500), with only the limit message", async () => {
    const provider = fakeProvider([callTool("search_nutrition_foods", { query: "egg" }), say("never sent")]);
    const result = await runChatTurn(chat, tools(), { provider, checkCap: capAfter(1), recordUsage: vi.fn() });
    expect(result).toMatchObject({ capReached: true, text: CAP_REACHED_REPLY });
  });

  it("an extraction stopped by the cap ends the turn at the next check", async () => {
    // The extraction call itself hits the cap: the tool fails, then the next chat call is refused.
    const analyze = vi.fn(async () => Promise.reject(new ApiErrorException("ai_cap_reached")));
    const provider = fakeProvider([callTool("create_meal_proposal", { description: "2 eggs" }), say("never sent")]);
    const result = await runChatTurn(chat, tools({ analyze }), { provider, checkCap: capAfter(1), recordUsage: vi.fn() });
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ capReached: true, text: CAP_REACHED_REPLY });
    expect(result.state.tools).toEqual([{ name: "create_meal_proposal", ok: false }]);
  });

  it("a failing cap count after work was done keeps the work, like a provider failure", async () => {
    const checkCap = vi.fn(noCap).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("count failed"));
    const provider = fakeProvider([callTool("create_meal_proposal", { description: "2 eggs" })]);
    const result = await runChatTurn(chat, tools(), { provider, checkCap, recordUsage: vi.fn() });
    expect(result).toMatchObject({ capReached: false, text: "Saved: Eggs (155 kcal)." });
  });

  it("a failing cap count before anything happened is ai_unavailable, not a crash", async () => {
    const checkCap = vi.fn(async () => Promise.reject(new Error("count failed")));
    await expect(runChatTurn(chat, tools(), { provider: fakeProvider(), checkCap, recordUsage: vi.fn() })).rejects.toMatchObject({
      code: "ai_unavailable",
    });
  });
});

describe("capReachedText", () => {
  it("is the limit message alone when the turn did nothing", () => {
    expect(capReachedText(newTurnState())).toBe(CAP_REACHED_REPLY);
  });
});

describe("fallbackText", () => {
  it("describes only what the turn actually did", () => {
    const state = newTurnState();
    expect(fallbackText(state)).toBe("Sorry, I couldn't finish that. Please try again.");
    state.cards.push({ kind: "proposal", state: "unsaved", proposal });
    state.cards.push({
      kind: "proposal",
      state: "unsaved",
      proposal: { ...proposal, needs_clarification: true, clarification_question: "How big was it?" },
    });
    expect(fallbackText(state)).toBe("Eggs: about 155 kcal. Save it if it looks right.\nHow big was it?");
  });
});
