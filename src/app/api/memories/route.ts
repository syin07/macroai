import { z } from "zod";
import type { MemoriesResponse } from "@/types/api";
import { ApiErrorException, toErrorResponse } from "@/lib/api-error";
import { requireUser } from "@/lib/auth/server";
import { listMemories } from "@/lib/memory/store";

// Error name and message only: never memory text.
function logFailure(route: string, error: unknown) {
  if (error instanceof ApiErrorException || error instanceof z.ZodError) return;
  console.error(`${route} failed:`, error instanceof Error ? `${error.name}: ${error.message}` : "non-Error thrown");
}

// GET /api/memories → { memories } — the user's live memories, newest first. Deleted ones never appear.
export async function GET() {
  try {
    const { user, supabase } = await requireUser();
    const body: MemoriesResponse = { memories: await listMemories(supabase, user.id) };
    return Response.json(body, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    logFailure("GET /api/memories", error);
    return toErrorResponse(error);
  }
}
