import { ApiErrorException, toErrorResponse } from "@/lib/api-error";
import { requireUser } from "@/lib/auth/server";
import { getMe } from "@/lib/database/profile";

// GET /api/me → Me. 401 signed out, 403 not_approved for unapproved accounts, so `approved` is
// always true here; the not-approved page reads approval from getSession() in src/lib/auth/client.ts.
export async function GET() {
  try {
    const { user, supabase } = await requireUser();
    const me = await getMe(supabase, user);
    return Response.json(me, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (!(error instanceof ApiErrorException)) console.error("GET /api/me failed:", error);
    return toErrorResponse(error);
  }
}
