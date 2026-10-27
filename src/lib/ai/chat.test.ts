import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { Meal, MealProposal } from "@/types/api";
import { ApiErrorException } from "@/lib/api-error";
import { callTool, fakeProvider, say } from "./__fixtures__/chat-fakes";
import { MAX_TOOL_STEPS, fallbackText, runChatTurn } from "./chat";
import { newTurnState, type MealStore, type ToolContext } from "./tools";

const chat = { system: "SYSTEM", context: "CONTEXT", messages: [{ role: "user" as const, text: "hi" }] };

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
    searchMeals: vi.fn(),
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
    const result = await runChatTurn(chat, tools({ meals: null }), { provider, recordUsage: vi.fn() });
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
    const result = await runChatTurn(chat, tools(), { provider, recordUsage });

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
    const result = await runChatTurn(chat, ctx, { provider, recordUsage: vi.fn() });
    expect(provider.chat).toHaveBeenCalledTimes(MAX_TOOL_STEPS);
    expect(ctx.lookup.searchFoods).toHaveBeenCalledTimes(MAX_TOOL_STEPS - 1);
    expect(result.text).toBe("Sorry, I couldn't finish that. Please try again.");
  });

  it("throws ai_unavailable when the model fails before anything happened", async () => {
    const provider = fakeProvider();
    provider.chat.mockRejectedValue(new Error("503"));
    await expect(runChatTurn(chat, tools(), { provider, recordUsage: vi.fn() })).rejects.toMatchObject({
      code: "ai_unavailable",
    } satisfies Partial<ApiErrorException>);
  });

  it("still reports a meal saved before the model failed, so a retry can't save it twice", async () => {
    const provider = fakeProvider([callTool("create_meal_proposal", { description: "2 eggs" })]);
    provider.chat.mockImplementationOnce(provider.chat.getMockImplementation()!).mockRejectedValueOnce(new Error("timeout"));
    const result = await runChatTurn(chat, tools(), { provider, recordUsage: vi.fn() });
    expect(result.text).toBe("Saved: Eggs (155 kcal).");
    expect(result.state.mealChanged).toBe(true);
  });

  it("keeps the answer when recording usage fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const provider = fakeProvider([say("Hi")]);
    const result = await runChatTurn(chat, tools(), { provider, recordUsage: vi.fn(async () => Promise.reject(new Error("db"))) });
    expect(result.text).toBe("Hi");
    errors.mockRestore();
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
