import type { SupabaseClient } from "@supabase/supabase-js";
import type { Memory } from "@/types/api";

// Every read and write of user_memories (and memory_candidates) goes through here.
//
// `supabase` is always the user's own client from requireUser(), so RLS limits every query to their
// rows; the explicit user_id filters are a second guard. `userId` is the session user's id, never a
// request or model value.
//
// Deletion is a soft delete (deleted_at). A deleted memory is filtered out of every read the app and
// the model see — GET /api/memories, retrieval, export (database/export.ts) — and its text is kept only
// so the extraction pass won't learn the same thing again behind the user's back
// (loadMemoriesForDedup). Account deletion removes the rows for real (cascade from auth.users).

export type MemoryCategory = Memory["category"];

export const MEMORY_COLUMNS = "id, category, content, created_at, updated_at";

// More than any real user will have; bounds the rows read for in-code ranking and dedup.
export const MAX_MEMORIES_READ = 500;

export interface MemoryRow extends Memory {
  deleted_at?: string | null;
}

export function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    category: row.category,
    content: row.content,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function failed(what: string, error: { message: string }): Error {
  return new Error(`user_memories ${what} failed: ${error.message}`);
}

// The user's live memories, newest first (by creation, so editing one doesn't reorder the list).
export async function listMemories(supabase: SupabaseClient, userId: string): Promise<Memory[]> {
  const { data, error } = await supabase
    .from("user_memories")
    .select(MEMORY_COLUMNS)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(MAX_MEMORIES_READ)
    .overrideTypes<MemoryRow[], { merge: false }>();
  if (error) throw failed("select", error);
  return (data ?? []).map(toMemory);
}

// Live and deleted memories, for deduplication only. Never return the deleted ones to a caller that
// shows them to the user or the model.
export async function loadMemoriesForDedup(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ live: Memory[]; deleted: Memory[] }> {
  const { data, error } = await supabase
    .from("user_memories")
    .select(`${MEMORY_COLUMNS}, deleted_at`)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(MAX_MEMORIES_READ)
    .overrideTypes<MemoryRow[], { merge: false }>();
  if (error) throw failed("select", error);
  const rows = data ?? [];
  return {
    live: rows.filter((row) => !row.deleted_at).map(toMemory),
    deleted: rows.filter((row) => row.deleted_at).map(toMemory),
  };
}

export interface NewMemory {
  category: MemoryCategory;
  content: string;
  sourceMessageId?: string | null;
}

export async function insertMemory(supabase: SupabaseClient, userId: string, memory: NewMemory): Promise<Memory> {
  const { data, error } = await supabase
    .from("user_memories")
    .insert({
      user_id: userId,
      category: memory.category,
      content: memory.content,
      source_message_id: memory.sourceMessageId ?? null,
    })
    .select(MEMORY_COLUMNS)
    .single<MemoryRow>();
  if (error || !data) throw failed("insert", error ?? { message: "no row returned" });
  return toMemory(data);
}

// Changes a live memory. Returns null when there is no live memory with that id for this user (never
// existed, someone else's, or deleted), which routes turn into 404. updated_at is set by the trigger.
export async function updateMemory(
  supabase: SupabaseClient,
  userId: string,
  memoryId: string,
  changes: { content: string; category?: MemoryCategory },
): Promise<Memory | null> {
  const { data, error } = await supabase
    .from("user_memories")
    .update(changes)
    .eq("id", memoryId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .select(MEMORY_COLUMNS)
    .maybeSingle<MemoryRow>();
  if (error) throw failed("update", error);
  return data ? toMemory(data) : null;
}

// Soft-deletes a live memory. Returns false when there was none to delete (→ 404).
export async function deleteMemory(
  supabase: SupabaseClient,
  userId: string,
  memoryId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const { data, error } = await supabase
    .from("user_memories")
    .update({ deleted_at: now.toISOString() })
    .eq("id", memoryId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle<{ id: string }>();
  if (error) throw failed("delete", error);
  return data !== null;
}

// --- Candidates (first sightings waiting for a repeat; see extract.ts) ---

export interface MemoryCandidate {
  id: string;
  category: MemoryCategory;
  content: string;
  occurrences: number;
  last_seen_at: string;
}

const CANDIDATE_COLUMNS = "id, category, content, occurrences, last_seen_at";

function candidateFailed(what: string, error: { message: string }): Error {
  return new Error(`memory_candidates ${what} failed: ${error.message}`);
}

// Drops candidates not seen since `cutoff`, then returns the rest.
export async function loadCandidates(supabase: SupabaseClient, userId: string, cutoff: Date): Promise<MemoryCandidate[]> {
  const pruned = await supabase
    .from("memory_candidates")
    .delete()
    .eq("user_id", userId)
    .lt("last_seen_at", cutoff.toISOString());
  if (pruned.error) throw candidateFailed("delete", pruned.error);

  const { data, error } = await supabase
    .from("memory_candidates")
    .select(CANDIDATE_COLUMNS)
    .eq("user_id", userId)
    .order("last_seen_at", { ascending: false })
    .limit(MAX_MEMORIES_READ)
    .overrideTypes<MemoryCandidate[], { merge: false }>();
  if (error) throw candidateFailed("select", error);
  return (data ?? []).map((row) => ({ ...row, occurrences: Number(row.occurrences) }));
}

export async function insertCandidate(
  supabase: SupabaseClient,
  userId: string,
  candidate: { category: MemoryCategory; content: string },
  now: Date,
): Promise<void> {
  const { error } = await supabase.from("memory_candidates").insert({
    user_id: userId,
    category: candidate.category,
    content: candidate.content,
    occurrences: 1,
    last_seen_at: now.toISOString(),
  });
  if (error) throw candidateFailed("insert", error);
}

export async function bumpCandidate(
  supabase: SupabaseClient,
  userId: string,
  candidate: MemoryCandidate,
  now: Date,
): Promise<void> {
  const { error } = await supabase
    .from("memory_candidates")
    .update({ occurrences: candidate.occurrences + 1, last_seen_at: now.toISOString() })
    .eq("id", candidate.id)
    .eq("user_id", userId);
  if (error) throw candidateFailed("update", error);
}

export async function deleteCandidate(supabase: SupabaseClient, userId: string, candidateId: string): Promise<void> {
  const { error } = await supabase.from("memory_candidates").delete().eq("id", candidateId).eq("user_id", userId);
  if (error) throw candidateFailed("delete", error);
}
