import { z } from "zod";
import type { Memory } from "@/types/api";
import { ApiErrorException, toErrorResponse } from "@/lib/api-error";
import { requireUser } from "@/lib/auth/server";
import { deleteMemory, updateMemory } from "@/lib/memory/store";
import { memoryIdParamSchema, patchMemoryRequestSchema } from "@/lib/validation";

// PATCH  /api/memories/:id { content } → Memory
// DELETE /api/memories/:id → 204. Soft delete: deleted_at is set and the memory stops being used
//        everywhere (list, retrieval, export); see src/lib/memory/store.ts.
// A missing, already-deleted, or someone else's memory is 404. So is a malformed id: it can't match.

interface Context {
  params: Promise<{ id: string }>;
}

// Error name and message only: never memory text.
function logFailure(route: string, error: unknown) {
  if (error instanceof ApiErrorException || error instanceof z.ZodError) return;
  console.error(`${route} failed:`, error instanceof Error ? `${error.name}: ${error.message}` : "non-Error thrown");
}

async function memoryIdFrom(context: Context): Promise<string> {
  const parsed = memoryIdParamSchema.safeParse((await context.params).id);
  if (!parsed.success) throw new ApiErrorException("not_found");
  return parsed.data;
}

export async function PATCH(request: Request, context: Context) {
  try {
    const { user, supabase } = await requireUser();
    const memoryId = await memoryIdFrom(context);
    const { content } = patchMemoryRequestSchema.parse(await request.json().catch(() => null));
    const memory: Memory | null = await updateMemory(supabase, user.id, memoryId, { content });
    if (!memory) throw new ApiErrorException("not_found");
    return Response.json(memory, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    logFailure("PATCH /api/memories/:id", error);
    return toErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const { user, supabase } = await requireUser();
    const memoryId = await memoryIdFrom(context);
    if (!(await deleteMemory(supabase, user.id, memoryId))) throw new ApiErrorException("not_found");
    return new Response(null, { status: 204 });
  } catch (error) {
    logFailure("DELETE /api/memories/:id", error);
    return toErrorResponse(error);
  }
}
