import { cookies } from "next/headers";
import { z } from "zod";
import { ApiErrorException, toErrorResponse } from "@/lib/api-error";
import { requireUser } from "@/lib/auth/server";
import { deleteAccount } from "@/lib/database/account";
import { deleteAccountRequestSchema } from "@/lib/validation";

// DELETE /api/account { confirm: "DELETE" } → 204 and the session ends (PRD FR-18). Deletes the
// session user's auth row with the service role, which cascades to all their data, then clears the
// session cookies. The user id comes from requireUser(); the body only carries the confirmation.

function logFailure(error: unknown) {
  if (error instanceof ApiErrorException || error instanceof z.ZodError) return;
  console.error("DELETE /api/account failed:", error instanceof Error ? `${error.name}: ${error.message}` : "unknown error");
}

// Supabase's SSR cookies are named sb-<project-ref>-auth-token (plus .0/.1 chunks and a code verifier).
async function clearSessionCookies() {
  const cookieStore = await cookies();
  for (const { name } of cookieStore.getAll()) {
    if (name.startsWith("sb-")) cookieStore.delete(name);
  }
}

export async function DELETE(request: Request) {
  try {
    const { user, supabase } = await requireUser();
    deleteAccountRequestSchema.parse(await request.json().catch(() => null));

    await deleteAccount(user.id);

    // The user is gone, so the Auth server may answer 404/403 here; signOut still drops the local
    // session. Clearing the cookies directly covers any case where it doesn't.
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch (error) {
      logFailure(error);
    }
    await clearSessionCookies();

    return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    logFailure(error);
    return toErrorResponse(error);
  }
}
