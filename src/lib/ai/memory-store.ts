import type { SupabaseClient } from "@supabase/supabase-js";
import { saveStatedMemory } from "@/lib/memory/extract";
import { retrieveMemories } from "@/lib/memory/retrieve";
import { deleteMemory } from "@/lib/memory/store";
import type { MemoryStore } from "./tools";

// The chat tools' view of B13's memory functions, bound to the session user and this turn's message.
// A thin adapter: search is B13's retrieval (deleted memories never appear), save goes through B13's
// explicit-statement rule and dedup, delete is B13's soft delete.
export function createMemoryStore(
  supabase: SupabaseClient,
  userId: string,
  turn: { userMessage: string; sourceMessageId: string | null },
): MemoryStore {
  return {
    search: (query) => retrieveMemories(supabase, userId, query),
    save: (memory) => saveStatedMemory(supabase, userId, { ...memory, ...turn }),
    remove: (memoryId) => deleteMemory(supabase, userId, memoryId),
  };
}
