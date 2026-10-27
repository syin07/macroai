import { requireUser } from "@/lib/auth/server";
import { completeOnboarding } from "@/lib/database/profile";
import { handleRouteError } from "../../_lib/route";

// POST /api/onboarding/complete (no body) → Me with onboarding_complete: true. Idempotent. Goals and
// time zone are optional during onboarding and saved through their own endpoints, so nothing else is
// required first.
export async function POST() {
  try {
    const { user, supabase } = await requireUser();
    const me = await completeOnboarding(supabase, user);
    return Response.json(me, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return handleRouteError("POST /api/onboarding/complete", error);
  }
}
