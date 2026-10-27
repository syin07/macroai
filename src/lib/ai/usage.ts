import type { SupabaseClient } from "@supabase/supabase-js";
import type { TokenUsage } from "./extraction";
import { costUsd } from "./pricing";

// One ai_usage row per model call, including calls whose output was rejected: they cost the same and
// count toward the daily cap (AI_DAILY_CALL_CAP).

export interface UsageEntry {
  model: string;
  usage: TokenUsage;
}

export type RecordUsage = (entry: UsageEntry) => Promise<void>;

// "ai/memory" is the memory-extraction second pass after a chat turn (src/lib/memory/extract.ts).
export type AiEndpoint = "ai/analyze-meal" | "ai/chat" | "ai/memory";

export function usageRow(userId: string, endpoint: AiEndpoint, { model, usage }: UsageEntry) {
  return {
    user_id: userId,
    endpoint,
    model,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    // Unpriced models (MODEL_PRICES null) are stored as 0; the token counts are still exact.
    estimated_cost_usd: costUsd(model, usage) ?? 0,
  };
}

// Uses the user's own client: RLS lets users insert (never update or delete) their usage rows.
export function createUsageRecorder(supabase: SupabaseClient, userId: string, endpoint: AiEndpoint): RecordUsage {
  return async (entry) => {
    const { error } = await supabase.from("ai_usage").insert(usageRow(userId, endpoint, entry));
    if (error) throw new Error(`ai_usage insert failed: ${error.message}`);
  };
}
