import { ApiErrorException } from "@/lib/api-error";
import { requireUser } from "@/lib/auth/server";
import { deleteMessage } from "@/lib/database/messages";
import { messageIdParamSchema } from "@/lib/validation";
import { handleRouteError } from "../../_lib/route";

// DELETE /api/messages/:id → 204. Deletes the message only; meals it created or changed are untouched.

interface Context {
  params: Promise<{ id: string }>;
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const { user, supabase } = await requireUser();
    // A malformed id can't match any message, so it's a 404 like any other missing one.
    const id = messageIdParamSchema.safeParse((await context.params).id);
    if (!id.success || !(await deleteMessage(supabase, user.id, id.data))) throw new ApiErrorException("not_found");
    return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return handleRouteError("DELETE /api/messages/:id", error);
  }
}
