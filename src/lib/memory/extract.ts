import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Memory } from "@/types/api";
import { assertWithinAiCap, isAiCapReached } from "@/lib/ai/cap";
import {
  EXTRACT_MEMORY_SYSTEM_PROMPT,
  MEMORY_CATEGORIES,
  PROPOSE_MEMORY_TOOL,
  PROPOSE_MEMORY_TOOL_NAME,
  buildExtractMemoryUserText,
} from "@/lib/ai/prompts/extract-memory";
import type { AIProvider, ProviderTurn } from "@/lib/ai/provider";
import { getProvider } from "@/lib/ai/providers";
import { createUsageRecorder, type RecordUsage } from "@/lib/ai/usage";
import { uuid } from "@/lib/validation/common";
import { rankMemories } from "./retrieve";
import {
  bumpCandidate,
  deleteCandidate,
  insertCandidate,
  insertMemory,
  loadCandidates,
  loadMemoriesForDedup,
  updateMemory,
  type MemoryCategory,
  type NewMemory,
} from "./store";
import { compareMemoryText, containsQuote } from "./text";

// The memory second pass (PRD FR-13, §5.8), run after a chat turn:
//
//   1. Check the daily AI cap (the call counts toward it and is logged in ai_usage as "ai/memory").
//      The pass is optional, so it leaves the day's last call for the user: it skips at cap - 1.
//   2. Ask the provider, with a small prompt and one tool, whether the exchange holds a reusable fact.
//   3. Validate the proposal in code. The model never writes to the database.
//   4. Deduplicate against the user's memories: the same fact → skip; the same subject with new
//      numbers, or the saved memory the model says it replaces → update that one; the same fact as a
//      memory the user deleted → skip, so deleting a memory sticks.
//   5. Save rule: an explicit statement ("my usual shake is …", quoted from the user's own message) is
//      saved now. Anything else becomes a candidate and is saved only when the same thing comes up a
//      second time within CANDIDATE_TTL_DAYS ("the same correction twice"). This is what keeps a
//      one-time correction from becoming a permanent fact (FR-13).
//
// Best-effort: it never throws. Failures come back as { status: "skipped", reason } and are logged by
// error name and message only — never the user's message, the reply, memory text, or model output.

export const REPEATS_TO_SAVE = 2;
// Calls the memory pass leaves free under the daily cap, so it never uses the last one.
export const MEMORY_CAP_RESERVE = 1;
export const CANDIDATE_TTL_DAYS = 30;
export const MAX_MEMORY_CONTENT_CHARS = 300;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface MaybeSaveMemoryInput {
  supabase: SupabaseClient;        // the user's own client from requireUser()
  userId: string;                  // the session user's id, never a request or model value
  userMessage: string;             // this turn's user message text
  assistantReply: string;          // this turn's final assistant reply text
  sourceMessageId?: string | null; // the saved user message's id, stored as user_memories.source_message_id
}

export interface MaybeSaveMemoryDeps {
  provider?: AIProvider;           // defaults to getProvider(); pass the chat route's instance
  recordUsage?: RecordUsage;       // defaults to an ai_usage recorder for "ai/memory"
  now?: Date;
}

export type MemorySkipReason =
  | "empty_message"
  | "ai_cap_reached"
  | "ai_unavailable"
  | "invalid_output"
  | "no_candidate"
  | "duplicate"
  | "previously_deleted"
  | "awaiting_repeat"
  | "error";

export type MaybeSaveMemoryResult =
  | { status: "saved"; memory: Memory }
  | { status: "updated"; memory: Memory }
  | { status: "skipped"; reason: MemorySkipReason };

// The propose_memory tool input. Lenient about nulls vs. missing fields; strict about values.
const proposalSchema = z.object({
  has_memory: z.boolean(),
  category: z.enum(MEMORY_CATEGORIES).nullish(),
  content: z.string().trim().max(MAX_MEMORY_CONTENT_CHARS).nullish(),
  explicit: z.boolean().nullish(),
  evidence: z.string().nullish(),
  updates: z.string().trim().nullish(),
});

export interface MemoryProposal {
  category: MemoryCategory;
  content: string;
  explicit: boolean;  // as the model claimed it; extract.ts still checks the evidence
  evidence: string | null;
  updates: string | null;
}

// null → the model proposed nothing; "invalid" → it answered with something that fails the schema.
export function parseProposal(turn: Pick<ProviderTurn, "toolCalls">): MemoryProposal | null | "invalid" {
  const call = turn.toolCalls.find((c) => c.name === PROPOSE_MEMORY_TOOL_NAME);
  if (!call) return null;
  const parsed = proposalSchema.safeParse(call.input);
  if (!parsed.success) return "invalid";
  const { has_memory, category, content, explicit, evidence, updates } = parsed.data;
  if (!has_memory) return null;
  if (!category || !content) return "invalid";
  return { category, content, explicit: explicit === true, evidence: evidence ?? null, updates: updates || null };
}

const skipped = (reason: MemorySkipReason): MaybeSaveMemoryResult => ({ status: "skipped", reason });

function errorSummary(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "non-Error thrown";
}

export async function maybeSaveMemory(
  input: MaybeSaveMemoryInput,
  deps: MaybeSaveMemoryDeps = {},
): Promise<MaybeSaveMemoryResult> {
  try {
    return await run(input, deps);
  } catch (error) {
    console.error("maybeSaveMemory failed:", errorSummary(error));
    return skipped("error");
  }
}

async function run(input: MaybeSaveMemoryInput, deps: MaybeSaveMemoryDeps): Promise<MaybeSaveMemoryResult> {
  const { supabase, userId } = input;
  const userMessage = input.userMessage.trim();
  if (!userMessage) return skipped("empty_message");
  const now = deps.now ?? new Date();

  try {
    await assertWithinAiCap(supabase, userId, { now, reserve: MEMORY_CAP_RESERVE });
  } catch (error) {
    if (isAiCapReached(error)) return skipped("ai_cap_reached");
    throw error;
  }

  const { live, deleted } = await loadMemoriesForDedup(supabase, userId);
  const context = rankMemories(live, userMessage).map((memory, i) => ({ ref: `m${i + 1}`, memory }));

  const provider = deps.provider ?? getProvider();
  const recordUsage = deps.recordUsage ?? createUsageRecorder(supabase, userId, "ai/memory");
  let turn: ProviderTurn;
  try {
    turn = await provider.chat({
      system: EXTRACT_MEMORY_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          text: buildExtractMemoryUserText({
            userMessage,
            assistantReply: input.assistantReply,
            memories: context.map(({ ref, memory }) => ({ ref, category: memory.category, content: memory.content })),
          }),
        },
      ],
      tools: [PROPOSE_MEMORY_TOOL],
    });
  } catch (error) {
    // Name only: SDK errors can carry request or response bodies.
    console.error("maybeSaveMemory: provider call failed:", error instanceof Error ? error.name : "non-Error thrown");
    return skipped("ai_unavailable");
  }

  // The call was billed whatever it returned; a failed usage insert must not lose the answer.
  try {
    await recordUsage({ model: turn.model, usage: turn.usage });
  } catch (error) {
    console.error("maybeSaveMemory: could not record AI usage:", errorSummary(error));
  }

  const proposal = parseProposal(turn);
  if (proposal === "invalid") return skipped("invalid_output");
  if (proposal === null) return skipped("no_candidate");
  const { category, content } = proposal;

  // Explicit only if the model quoted the user's own words; otherwise it needs a repeat like anything else.
  const explicit = proposal.explicit && proposal.evidence !== null && containsQuote(userMessage, proposal.evidence);

  if (live.some((memory) => compareMemoryText(content, memory.content) === "same")) return skipped("duplicate");
  const target =
    context.find(({ ref }) => ref === proposal.updates)?.memory ??
    live.find((memory) => compareMemoryText(content, memory.content) === "revised") ??
    null;
  if (!target && deleted.some((memory) => compareMemoryText(content, memory.content) === "same")) {
    return skipped("previously_deleted");
  }

  let promoted: string | null = null; // the candidate this save completes
  if (!explicit) {
    const candidates = await loadCandidates(supabase, userId, new Date(now.getTime() - CANDIDATE_TTL_DAYS * DAY_MS));
    const seen = candidates.find((candidate) => compareMemoryText(content, candidate.content) === "same");
    if (!seen) {
      await insertCandidate(supabase, userId, { category, content }, now);
      return skipped("awaiting_repeat");
    }
    if (seen.occurrences + 1 < REPEATS_TO_SAVE) {
      await bumpCandidate(supabase, userId, seen, now);
      return skipped("awaiting_repeat");
    }
    promoted = seen.id;
  }

  const result = await writeMemory(supabase, userId, target, { category, content, sourceMessageId: input.sourceMessageId });
  if (promoted) await deleteCandidate(supabase, userId, promoted);
  return result;
}

// Updates `target` if given (and still live), otherwise inserts a new memory.
async function writeMemory(
  supabase: SupabaseClient,
  userId: string,
  target: Memory | null,
  memory: NewMemory,
): Promise<{ status: "saved" | "updated"; memory: Memory }> {
  if (target) {
    const updated = await updateMemory(supabase, userId, target.id, { content: memory.content, category: memory.category });
    if (updated) return { status: "updated", memory: updated };
    // null: deleted since we read it, so save it as a new memory instead.
  }
  const sourceMessageId = uuid.safeParse(memory.sourceMessageId).success ? memory.sourceMessageId : null;
  return { status: "saved", memory: await insertMemory(supabase, userId, { ...memory, sourceMessageId }) };
}

export type SaveStatedMemoryResult =
  | { status: "saved" | "updated"; memory: Memory }
  | { status: "duplicate"; memory: Memory }
  | { status: "not_stated" };

// The chat tool path (save_user_memory): the user asked, in this message, for something to be
// remembered. Same rules as an explicit statement in the second pass above: `evidence` must be quoted
// from the user's own message, or nothing is saved. Deduplicated the same way: the same fact → the
// existing memory; the same subject with new numbers → that memory is updated. A memory the user deleted
// earlier may be saved again here, because the user is asking for it again in their own words.
export async function saveStatedMemory(
  supabase: SupabaseClient,
  userId: string,
  input: { category: MemoryCategory; content: string; evidence: string; userMessage: string; sourceMessageId?: string | null },
): Promise<SaveStatedMemoryResult> {
  const content = input.content.trim();
  if (!content || !containsQuote(input.userMessage, input.evidence)) return { status: "not_stated" };

  const { live } = await loadMemoriesForDedup(supabase, userId);
  const same = live.find((memory) => compareMemoryText(content, memory.content) === "same");
  if (same) return { status: "duplicate", memory: same };
  const target = live.find((memory) => compareMemoryText(content, memory.content) === "revised") ?? null;
  return writeMemory(supabase, userId, target, { category: input.category, content, sourceMessageId: input.sourceMessageId });
}
