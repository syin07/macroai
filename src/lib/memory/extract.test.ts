import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppDb, type MemoryDbOptions } from "@/lib/database/__fixtures__/memory-supabase";
import {
  EXTRACT_MEMORY_SYSTEM_PROMPT,
  MAX_ASSISTANT_REPLY_CHARS,
  PROPOSE_MEMORY_TOOL,
} from "@/lib/ai/prompts/extract-memory";
import { memorySchema } from "@/lib/validation";
import { FAKE_USAGE, FakeMemoryProvider, NO_MEMORY, proposal, type FakeReply } from "./__fixtures__/fake-provider";
import { CANDIDATE_TTL_DAYS, maybeSaveMemory, parseProposal, saveStatedMemory } from "./extract";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-26T18:00:00Z");
const EARLIER = "2026-10-20T08:00:00+00:00";
const SOURCE_MESSAGE = "a2000000-0000-4000-8000-000000000001";

const SHAKE = "Usual shake: Fairlife Core Power 26g, 1 bottle";
const LOG_SHAKE = "had a Fairlife Core Power 26g after the gym";

type Row = Record<string, unknown>;

const memoryRow = (id: string, content: string, extra: Row = {}): Row => ({
  id,
  user_id: ME,
  category: "frequent_food",
  content,
  source_message_id: null,
  created_at: EARLIER,
  updated_at: EARLIER,
  deleted_at: null,
  ...extra,
});

const usageRows = (n: number, userId = ME): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `u${userId}-${i}`,
    user_id: userId,
    endpoint: "ai/chat",
    model: "claude-haiku-5-5",
    created_at: "2026-10-26T12:00:00Z",
  }));

interface Setup {
  replies?: FakeReply[];
  memories?: Row[];
  candidates?: Row[];
  usage?: Row[];
  fail?: MemoryDbOptions["fail"];
}

function setup({ replies = [], memories = [], candidates = [], usage = [], fail }: Setup = {}) {
  const db = createAppDb(
    {
      profiles: [
        { id: ME, timezone: "UTC" },
        { id: OTHER, timezone: "UTC" },
      ],
      user_memories: memories,
      memory_candidates: candidates,
      ai_usage: usage,
    },
    fail,
  );
  const provider = new FakeMemoryProvider(replies);
  const run = (userMessage: string, extra: { assistantReply?: string; sourceMessageId?: string | null } = {}) =>
    maybeSaveMemory(
      {
        supabase: db as unknown as SupabaseClient,
        userId: ME,
        userMessage,
        assistantReply: extra.assistantReply ?? "Logged it.",
        sourceMessageId: extra.sourceMessageId,
      },
      { provider, now: NOW },
    );
  const mine = (table: string) => db.rows(table).filter((row) => row.user_id === ME);
  return { db, provider, run, mine };
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv("AI_DAILY_CALL_CAP", "5");
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// Nothing the user said, the assistant replied, or the model proposed may reach the logs.
function expectNoContentLogged(...texts: string[]) {
  const logged = JSON.stringify(errorSpy.mock.calls);
  for (const text of texts) expect(logged).not.toContain(text);
}

describe("maybeSaveMemory: the model call", () => {
  it("sends the small prompt with one tool, the exchange, and refs for the relevant saved memories", async () => {
    const { provider, run } = setup({
      replies: [NO_MEMORY],
      memories: [memoryRow("m-shake", SHAKE), memoryRow("m-eggs", "Breakfast: 2 eggs and toast")],
    });
    await run("my usual shake please", { assistantReply: "x".repeat(MAX_ASSISTANT_REPLY_CHARS + 500) });

    expect(provider.chats).toHaveLength(1);
    const [chat] = provider.chats;
    expect(chat!.system).toBe(EXTRACT_MEMORY_SYSTEM_PROMPT);
    expect(chat!.tools).toEqual([PROPOSE_MEMORY_TOOL]);
    expect(chat!.messages).toHaveLength(1);
    const text = chat!.messages[0]!.role === "user" ? chat!.messages[0]!.text : "";
    expect(text).toContain(`m1 [frequent_food] ${SHAKE}`);
    expect(text).not.toContain("Breakfast"); // no keyword overlap, not sent
    expect(text).toContain("my usual shake please");
    expect(text).not.toContain("x".repeat(MAX_ASSISTANT_REPLY_CHARS + 1)); // reply is clipped
  });

  it("logs one ai_usage row under ai/memory for the session user", async () => {
    const { mine, run } = setup({ replies: [NO_MEMORY] });
    await run("2 eggs and toast");
    expect(mine("ai_usage")).toEqual([
      expect.objectContaining({
        user_id: ME,
        endpoint: "ai/memory",
        model: "claude-haiku-5-5",
        input_tokens: FAKE_USAGE.inputTokens,
        output_tokens: FAKE_USAGE.outputTokens,
        estimated_cost_usd: expect.any(Number),
      }),
    ]);
  });

  it("returns ai_cap_reached at the daily cap, without calling the model or logging usage", async () => {
    const { provider, mine, run } = setup({ replies: [proposal({ explicit: true })], usage: usageRows(5) });
    expect(await run(LOG_SHAKE)).toEqual({ status: "skipped", reason: "ai_cap_reached" });
    expect(provider.chats).toHaveLength(0);
    expect(mine("ai_usage")).toHaveLength(5);
    expect(mine("memory_candidates")).toHaveLength(0);
  });

  it("never takes the day's last call: skips silently at cap - 1", async () => {
    const { provider, mine, run } = setup({ replies: [proposal({ explicit: true })], usage: usageRows(4) });
    expect(await run(LOG_SHAKE)).toEqual({ status: "skipped", reason: "ai_cap_reached" });
    expect(provider.chats).toHaveLength(0);
    expect(mine("ai_usage")).toHaveLength(4);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("counts only the user's own calls toward the cap", async () => {
    const { provider, run } = setup({ replies: [NO_MEMORY], usage: [...usageRows(3), ...usageRows(20, OTHER)] });
    expect(await run(LOG_SHAKE)).toEqual({ status: "skipped", reason: "no_candidate" });
    expect(provider.chats).toHaveLength(1);
  });

  it("skips an empty message without a model call", async () => {
    const { provider, run } = setup();
    expect(await run("   ")).toEqual({ status: "skipped", reason: "empty_message" });
    expect(provider.chats).toHaveLength(0);
  });

  it("returns ai_unavailable when the provider fails, logging only the error name", async () => {
    const { mine, run } = setup({ replies: [new Error(`provider echoed: ${LOG_SHAKE}`)] });
    expect(await run(LOG_SHAKE)).toEqual({ status: "skipped", reason: "ai_unavailable" });
    expect(mine("ai_usage")).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
    expectNoContentLogged(LOG_SHAKE, "provider echoed");
  });

  it.each([
    ["no tool call", { text: "Nothing to remember.", toolCalls: [] }],
    ["has_memory false", NO_MEMORY],
  ])("returns no_candidate for %s, and still logs usage", async (_, reply) => {
    const { mine, run } = setup({ replies: [reply] });
    expect(await run("2 eggs and toast")).toEqual({ status: "skipped", reason: "no_candidate" });
    expect(mine("ai_usage")).toHaveLength(1);
    expect(mine("user_memories")).toHaveLength(0);
  });

  it.each([
    ["an unknown category", proposal({ category: "mood" })],
    ["no content", proposal({ content: null })],
    ["content over 300 characters", proposal({ content: "x".repeat(301) })],
    ["has_memory missing", { content: SHAKE }],
  ])("returns invalid_output for %s, saving nothing", async (_, reply) => {
    const { mine, run } = setup({ replies: [reply] });
    expect(await run(LOG_SHAKE)).toEqual({ status: "skipped", reason: "invalid_output" });
    expect(mine("ai_usage")).toHaveLength(1);
    expect(mine("user_memories")).toHaveLength(0);
    expect(mine("memory_candidates")).toHaveLength(0);
  });
});

describe("maybeSaveMemory: the save rule", () => {
  it("saves an explicit statement quoted from the user's message right away", async () => {
    const message = "From now on my usual shake is the Fairlife Core Power 26g, log one";
    const { mine, run } = setup({
      replies: [proposal({ explicit: true, evidence: "my usual shake is the Fairlife Core Power 26g" })],
    });
    const result = await run(message, { sourceMessageId: SOURCE_MESSAGE });

    expect(result.status).toBe("saved");
    if (result.status !== "saved") return;
    expect(memorySchema.parse(result.memory)).toEqual(result.memory);
    expect(result.memory).toMatchObject({ category: "frequent_food", content: SHAKE });
    expect(mine("user_memories")).toEqual([
      expect.objectContaining({ user_id: ME, content: SHAKE, source_message_id: SOURCE_MESSAGE, deleted_at: null }),
    ]);
    expect(mine("memory_candidates")).toHaveLength(0);
  });

  it("treats 'explicit' without the user's own words as a first sighting", async () => {
    const { mine, run } = setup({
      // The quote comes from the assistant's reply, not the user.
      replies: [proposal({ explicit: true, evidence: "your usual shake" })],
    });
    expect(await run(LOG_SHAKE, { assistantReply: "Logged your usual shake." })).toEqual({
      status: "skipped",
      reason: "awaiting_repeat",
    });
    expect(mine("user_memories")).toHaveLength(0);
    expect(mine("memory_candidates")).toEqual([expect.objectContaining({ content: SHAKE, occurrences: 1 })]);
  });

  it("saves a non-explicit fact only the second time it comes up, then drops the candidate", async () => {
    const { mine, run } = setup({
      replies: [proposal(), proposal({ content: "usual shake - Fairlife Core Power 26g, 1 bottle" })],
    });

    expect(await run(LOG_SHAKE)).toEqual({ status: "skipped", reason: "awaiting_repeat" });
    expect(mine("user_memories")).toHaveLength(0);
    expect(mine("memory_candidates")).toEqual([
      expect.objectContaining({ category: "frequent_food", content: SHAKE, occurrences: 1, last_seen_at: NOW.toISOString() }),
    ]);

    const second = await run("another Fairlife Core Power 26g");
    expect(second.status).toBe("saved");
    expect(mine("user_memories")).toHaveLength(1);
    expect(mine("memory_candidates")).toHaveLength(0);
  });

  it("doesn't count a correction with different numbers as the same correction", async () => {
    const { mine, run } = setup({
      replies: [
        proposal({ category: "correction", content: "Toast is 2 slices, not 1" }),
        proposal({ category: "correction", content: "Toast is 3 slices, not 1" }),
      ],
    });
    expect((await run("no, 2 slices of toast")).status).toBe("skipped");
    expect(await run("no, 3 slices of toast")).toEqual({ status: "skipped", reason: "awaiting_repeat" });
    expect(mine("memory_candidates")).toHaveLength(2);
    expect(mine("user_memories")).toHaveLength(0);
  });

  it(`forgets a first sighting after ${CANDIDATE_TTL_DAYS} days`, async () => {
    const stale = new Date(NOW.getTime() - (CANDIDATE_TTL_DAYS + 1) * 86_400_000).toISOString();
    const { mine, run } = setup({
      replies: [proposal()],
      candidates: [
        { id: "c-old", user_id: ME, category: "frequent_food", content: SHAKE, occurrences: 1, created_at: stale, last_seen_at: stale },
      ],
    });
    expect(await run(LOG_SHAKE)).toEqual({ status: "skipped", reason: "awaiting_repeat" });
    expect(mine("memory_candidates")).toEqual([expect.objectContaining({ content: SHAKE, last_seen_at: NOW.toISOString() })]);
    expect(mine("memory_candidates")[0]!.id).not.toBe("c-old");
  });

  it("stores a malformed source message id as null", async () => {
    const { mine, run } = setup({ replies: [proposal({ explicit: true, evidence: "my usual shake is Fairlife Core Power 26g" })] });
    await run("my usual shake is Fairlife Core Power 26g", { sourceMessageId: "not-a-uuid" });
    expect(mine("user_memories")[0]!.source_message_id).toBeNull();
  });
});

describe("maybeSaveMemory: deduplication", () => {
  const explicitShake = (content: string, extra = {}) =>
    proposal({ content, explicit: true, evidence: "my usual shake is", ...extra });

  it("skips a fact the user already has, without touching candidates", async () => {
    const { mine, run } = setup({
      replies: [explicitShake("Usual shake is Fairlife Core Power 26g, 1 bottle")],
      memories: [memoryRow("m-shake", SHAKE)],
    });
    expect(await run("my usual shake is Fairlife Core Power 26g")).toEqual({ status: "skipped", reason: "duplicate" });
    expect(mine("user_memories")).toEqual([expect.objectContaining({ id: "m-shake", content: SHAKE })]);
    expect(mine("memory_candidates")).toHaveLength(0);
  });

  it("updates the existing memory when only the numbers changed", async () => {
    const { mine, run } = setup({
      replies: [explicitShake("Usual shake: Fairlife Core Power 42g, 1 bottle")],
      memories: [memoryRow("m-shake", SHAKE)],
    });
    const result = await run("my usual shake is the Fairlife Core Power 42g now");
    expect(result).toMatchObject({ status: "updated", memory: { id: "m-shake", content: "Usual shake: Fairlife Core Power 42g, 1 bottle" } });
    expect(mine("user_memories")).toHaveLength(1);
  });

  it("updates the saved memory the model says it replaces", async () => {
    const { provider, mine, run } = setup({
      replies: [explicitShake("Usual shake: Premier Protein vanilla, 1 bottle", { category: "brand", updates: "m1" })],
      memories: [memoryRow("m-shake", SHAKE), memoryRow("m-eggs", "Usual breakfast: 2 eggs")],
    });
    const result = await run("my usual shake is Premier Protein vanilla now");
    expect(result).toMatchObject({
      status: "updated",
      memory: { id: "m-shake", category: "brand", content: "Usual shake: Premier Protein vanilla, 1 bottle" },
    });
    expect(provider.chats[0]!.messages[0]).toMatchObject({ text: expect.stringContaining(`m1 [frequent_food] ${SHAKE}`) });
    expect(mine("user_memories").map((row) => row.content).sort()).toEqual(
      ["Usual breakfast: 2 eggs", "Usual shake: Premier Protein vanilla, 1 bottle"].sort(),
    );
  });

  it("ignores an updates ref that wasn't in the prompt and saves a new memory", async () => {
    const { mine, run } = setup({
      replies: [explicitShake("Usual shake: Premier Protein vanilla, 1 bottle", { updates: "m7" })],
      memories: [memoryRow("m-shake", SHAKE)],
    });
    expect((await run("my usual shake is Premier Protein vanilla")).status).toBe("saved");
    expect(mine("user_memories")).toHaveLength(2);
  });

  it("never re-learns a memory the user deleted", async () => {
    const { mine, run } = setup({
      replies: [explicitShake(SHAKE), proposal(), proposal()],
      memories: [memoryRow("m-shake", SHAKE, { deleted_at: "2026-10-25T00:00:00Z" })],
    });
    for (let i = 0; i < 3; i++) {
      expect(await run("my usual shake is Fairlife Core Power 26g")).toEqual({ status: "skipped", reason: "previously_deleted" });
    }
    expect(mine("user_memories").filter((row) => row.deleted_at === null)).toHaveLength(0);
    expect(mine("memory_candidates")).toHaveLength(0);
  });

  it("keeps users apart: another user's memories and candidates don't count", async () => {
    const theirMemory = { ...memoryRow("b-shake", SHAKE), user_id: OTHER };
    const theirCandidate = { id: "b-c", user_id: OTHER, category: "frequent_food", content: SHAKE, occurrences: 1, created_at: EARLIER, last_seen_at: NOW.toISOString() };
    const { db, mine, run } = setup({ replies: [proposal()], memories: [theirMemory], candidates: [theirCandidate] });

    // Not a duplicate of theirs, and their candidate doesn't make this a repeat.
    expect(await run(LOG_SHAKE)).toEqual({ status: "skipped", reason: "awaiting_repeat" });
    expect(mine("user_memories")).toHaveLength(0);
    expect(mine("memory_candidates")).toEqual([expect.objectContaining({ occurrences: 1 })]);
    expect(db.rows("user_memories")).toEqual([theirMemory]);
    expect(db.rows("memory_candidates").filter((row) => row.user_id === OTHER)).toEqual([theirCandidate]);
  });
});

describe("maybeSaveMemory: failures", () => {
  it("returns error on a database failure and logs no content", async () => {
    const message = "my usual shake is the Fairlife Core Power 26g";
    const { run } = setup({
      replies: [proposal({ explicit: true, evidence: message })],
      fail: { table: "user_memories", op: "insert" },
    });
    expect(await run(message, { assistantReply: "Got it, saved." })).toEqual({ status: "skipped", reason: "error" });
    expect(errorSpy).toHaveBeenCalledWith("maybeSaveMemory failed:", "Error: user_memories insert failed: boom");
    expectNoContentLogged(message, SHAKE, "Got it, saved.");
  });

  it("keeps going when the usage insert fails", async () => {
    const message = "my usual shake is the Fairlife Core Power 26g";
    const { run } = setup({ replies: [proposal({ explicit: true, evidence: message })], fail: { table: "ai_usage", op: "insert" } });
    expect((await run(message)).status).toBe("saved");
    expect(errorSpy).toHaveBeenCalledWith("maybeSaveMemory: could not record AI usage:", expect.stringContaining("boom"));
  });
});

describe("parseProposal", () => {
  const turn = (input: unknown, name = "propose_memory") => ({ toolCalls: [{ id: "1", name, input }] });

  it("reads the propose_memory call and ignores other tools", () => {
    expect(parseProposal(turn(proposal({ content: `  ${SHAKE}  `, updates: "" })))).toEqual({
      category: "frequent_food",
      content: SHAKE,
      explicit: false,
      evidence: null,
      updates: null,
    });
    expect(parseProposal(turn(proposal(), "save_meal"))).toBeNull();
  });

  it("accepts missing optional fields when there is no memory", () => {
    expect(parseProposal(turn({ has_memory: false }))).toBeNull();
  });
});

describe("saveStatedMemory (the chat save_user_memory tool)", () => {
  const MSG = "remember my usual shake is Fairlife Core Power 42g";
  const NEW = "Usual shake: Fairlife Core Power 42g, 1 bottle";
  const client = (rows: Row[]) => {
    const db = createAppDb({ user_memories: rows });
    return { db, supabase: db as unknown as SupabaseClient };
  };
  const input = (extra: Partial<Parameters<typeof saveStatedMemory>[2]> = {}) => ({
    category: "frequent_food" as const,
    content: NEW,
    evidence: "my usual shake is Fairlife Core Power 42g",
    userMessage: MSG,
    sourceMessageId: SOURCE_MESSAGE,
    ...extra,
  });

  it("saves nothing unless the evidence is quoted from the user's message", async () => {
    const { db, supabase } = client([]);
    expect(await saveStatedMemory(supabase, ME, input({ evidence: "my shake is 42g protein" }))).toEqual({ status: "not_stated" });
    expect(db.rows("user_memories")).toHaveLength(0);
  });

  it("updates the memory with the same subject and new numbers instead of adding one", async () => {
    const { db, supabase } = client([memoryRow("m1", SHAKE), memoryRow("m2", SHAKE, { user_id: OTHER })]);
    const result = await saveStatedMemory(supabase, ME, input());
    expect(result).toMatchObject({ status: "updated", memory: { id: "m1", content: NEW } });
    expect(db.rows("user_memories").map((row) => [row.id, row.content])).toEqual([
      ["m1", NEW],
      ["m2", SHAKE],
    ]);
  });

  it("saves a new memory with its source message, even one the user deleted before", async () => {
    const { db, supabase } = client([memoryRow("m1", NEW, { deleted_at: EARLIER })]);
    expect(await saveStatedMemory(supabase, ME, input())).toMatchObject({ status: "saved", memory: { content: NEW } });
    expect(db.rows("user_memories").filter((row) => !row.deleted_at)).toMatchObject([
      { user_id: ME, content: NEW, source_message_id: SOURCE_MESSAGE },
    ]);
  });
});
