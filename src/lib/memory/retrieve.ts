import type { SupabaseClient } from "@supabase/supabase-js";
import type { Memory } from "@/types/api";
import { listMemories } from "./store";
import { keywords, overlap } from "./text";

// Memory retrieval for each AI request (PRD FR-13 "retrieve only relevant memories", FR-14 step 2):
// the top 8 live memories by keyword overlap with the message, plus every response_style memory
// (how the user wants answers applies to every message). Deleted memories are never read.

export const MAX_RELEVANT_MEMORIES = 8;

// Pure ranking, separate from the query so it can be tested directly. Returns response_style memories
// first (oldest first, so their order is stable), then up to `limit` other memories that share at least
// one keyword with the message: most shared keywords first, then most recently updated, then id.
export function rankMemories(memories: Memory[], message: string, limit = MAX_RELEVANT_MEMORIES): Memory[] {
  const style = memories
    .filter((memory) => memory.category === "response_style")
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));

  const query = keywords(message);
  const relevant = memories
    .filter((memory) => memory.category !== "response_style")
    .map((memory) => ({ memory, score: overlap(keywords(memory.content), query) }))
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.memory.updated_at.localeCompare(a.memory.updated_at) ||
        a.memory.id.localeCompare(b.memory.id),
    )
    .slice(0, limit)
    .map(({ memory }) => memory);

  return [...style, ...relevant];
}

// `supabase` is the user's own client from requireUser() and `userId` the session user's id.
export async function retrieveMemories(supabase: SupabaseClient, userId: string, message: string): Promise<Memory[]> {
  return rankMemories(await listMemories(supabase, userId), message);
}

// analyzeMeal's `loadMemories` dependency: the retrieved memories' text, the shape ExtractMealInput
// takes. A photo with no caption still gets the response_style memories.
export function memoryLoader(supabase: SupabaseClient) {
  return async (userId: string, text: string | undefined): Promise<string[]> =>
    (await retrieveMemories(supabase, userId, text ?? "")).map((memory) => memory.content);
}
