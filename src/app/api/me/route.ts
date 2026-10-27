import type { Me } from "@/types/api";
import { ApiErrorException, toErrorResponse } from "@/lib/api-error";
import { requireUser } from "@/lib/auth/server";

// GET /api/me → Me. 401 signed out, 403 not_approved for unapproved accounts, so `approved` is
// always true here; the not-approved page reads approval from getSession() in src/lib/auth/client.ts.
export async function GET() {
  try {
    const { user, supabase } = await requireUser();
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("display_name, onboarding_complete")
      .eq("id", user.id)
      .maybeSingle();
    if (error) throw new Error(`profiles select failed: ${error.message}`);

    const me: Me = {
      user_id: user.id,
      email: user.email ?? "",
      display_name: profile?.display_name ?? null,
      approved: true,
      onboarding_complete: profile?.onboarding_complete ?? false,
    };
    return Response.json(me, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (!(error instanceof ApiErrorException)) console.error("GET /api/me failed:", error);
    return toErrorResponse(error);
  }
}
