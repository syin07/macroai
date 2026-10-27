import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeMeal } from "@/lib/ai/analyze";
import type { ExtractionResult } from "@/lib/ai/extraction";
import type { ExtractMealInput, ExtractMealOutput } from "@/lib/ai/provider";
import { APPROVED_USER, createFakeSupabase, signedIn, stubSupabaseEnv } from "@/lib/auth/__fixtures__/fake-supabase";
import { createAppDb, type MemoryDb } from "@/lib/database/__fixtures__/memory-supabase";
import { loadExportMemories } from "@/lib/database/export";
import { FakeMemoryProvider, proposal } from "./__fixtures__/fake-provider";
import { maybeSaveMemory } from "./extract";
import { memoryLoader, retrieveMemories } from "./retrieve";

// B13 eval (plan): log "Fairlife Core Power 26g" twice → "my usual shake" resolves to it; delete the
// memory → it no longer resolves. Fake provider, real everything else: extraction save rule, dedup,
// retrieval, analyzeMeal's memory loading, the DELETE route, and export, all against one in-memory db.

let fake: unknown;
vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn(() => fake) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: vi.fn() }) }));
const { DELETE } = await import("@/app/api/memories/[id]/route");
const { GET } = await import("@/app/api/memories/route");

const ME = APPROVED_USER.id;
const SHAKE = "Usual shake: Fairlife Core Power 26g, 1 bottle";
const USAGE = { inputTokens: 900, outputTokens: 120 };

// The extraction model, faked: it resolves "my usual shake" only when a memory names the shake, and
// otherwise asks which shake — the behaviour the extract-meal prompt's "Saved memories" rule asks for.
function extractionModel(input: ExtractMealInput): ExtractMealOutput {
  const usual = input.memories.find((memory) => /^usual shake:/i.test(memory));
  const product = usual?.replace(/^usual shake:\s*/i, "").split(",")[0]?.trim();
  const result: ExtractionResult = product
    ? {
        intent: "log_meal",
        explanation: null,
        meals: [
          {
            name: "Protein Shake",
            consumed_at: null,
            time_phrase: null,
            needs_clarification: false,
            clarification_question: null,
            foods: [
              {
                name: product,
                brand: "Fairlife",
                quantity: 1,
                unit: "bottle",
                grams: 414,
                preparation: null,
                estimated_quantity: false,
                inferred: false,
                confidence: "high",
                search_query: "fairlife core power 26g",
                estimated_macros: { calories: 170, protein_g: 26, carbs_g: 8, fat_g: 4.5 },
                estimate_range: { calories_low: 165, calories_high: 175, protein_g_low: 26, protein_g_high: 26 },
                notes: "From saved memory",
              },
            ],
          },
        ],
      }
    : { intent: "other", meals: [], explanation: "Which shake did you have?" };
  return { result, usage: USAGE, model: "claude-haiku-5-5", promptVersion: "extract-meal@test" };
}

describe("eval: my usual shake", () => {
  let db: MemoryDb;
  let provider: FakeMemoryProvider;
  const client = () => db as unknown as SupabaseClient;

  beforeEach(() => {
    stubSupabaseEnv();
    vi.stubEnv("AI_DAILY_CALL_CAP", "50");
    db = createAppDb({ profiles: [{ id: ME, timezone: "UTC" }] });
    fake = { ...createFakeSupabase(signedIn(true)), from: db.from };
    // The memory pass sees a plain log both times: not explicit, so it needs the repeat.
    provider = new FakeMemoryProvider([
      proposal({ content: SHAKE }),
      proposal({ content: "Usual shake: Fairlife Core Power 26g, 1 bottle" }),
      proposal({ content: SHAKE }),
    ]);
    provider.onExtract = extractionModel;
  });
  afterEach(() => vi.unstubAllEnvs());

  const logShake = () =>
    maybeSaveMemory(
      { supabase: client(), userId: ME, userMessage: "had a Fairlife Core Power 26g", assistantReply: "Logged: Fairlife Core Power 26g." },
      { provider },
    );

  const askForUsualShake = () =>
    analyzeMeal(
      { text: "my usual shake", user: { id: ME, timezone: "UTC" } },
      {
        provider,
        lookup: { searchFoods: async () => [], getFood: async () => null },
        recordUsage: async () => {},
        loadMemories: memoryLoader(client()),
      },
    );

  it("resolves after two logs, and stops resolving once the memory is deleted", async () => {
    // Log 1: a first sighting only.
    expect(await logShake()).toEqual({ status: "skipped", reason: "awaiting_repeat" });
    expect(await retrieveMemories(client(), ME, "my usual shake")).toEqual([]);
    expect((await askForUsualShake()).proposals).toEqual([]);

    // Log 2: the repeat saves it.
    const saved = await logShake();
    expect(saved).toMatchObject({ status: "saved", memory: { category: "frequent_food", content: SHAKE } });
    if (saved.status !== "saved") return;

    // "my usual shake" now resolves.
    expect(await retrieveMemories(client(), ME, "my usual shake")).toEqual([saved.memory]);
    const resolved = await askForUsualShake();
    expect(provider.extractions.at(-1)!.memories).toEqual([SHAKE]);
    expect(resolved.intent).toBe("log_meal");
    expect(resolved.proposals[0]!.items[0]).toMatchObject({ food_name: "Fairlife Core Power 26g", nutrition_source: "ai" });
    expect(resolved.proposals[0]!.totals.protein_g).toBe(26);

    // Delete it through the API.
    const response = await DELETE(new Request("http://localhost/api/memories/x", { method: "DELETE" }), {
      params: Promise.resolve({ id: saved.memory.id }),
    });
    expect(response.status).toBe(204);

    // It no longer resolves, and it's gone everywhere the user or the model could see it.
    expect(await retrieveMemories(client(), ME, "my usual shake")).toEqual([]);
    const after = await askForUsualShake();
    expect(provider.extractions.at(-1)!.memories).toEqual([]);
    expect(after.proposals).toEqual([]);
    expect(after.explanation).toBe("Which shake did you have?");
    expect((await (await GET()).json()).memories).toEqual([]);
    expect(await loadExportMemories(client(), ME)).toEqual([]);

    // Logging it again doesn't bring it back behind the user's back.
    expect(await logShake()).toEqual({ status: "skipped", reason: "previously_deleted" });
    expect(await retrieveMemories(client(), ME, "my usual shake")).toEqual([]);

    // Each memory pass was one model call, logged against the cap.
    expect(db.rows("ai_usage").filter((row) => row.endpoint === "ai/memory")).toHaveLength(3);
  });
});
