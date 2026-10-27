import { requireUser } from "@/lib/auth/server";
import { getPreferences, updatePreferences } from "@/lib/database/preferences";
import { patchPreferencesRequestSchema } from "@/lib/validation";
import { handleRouteError } from "../_lib/route";

const NO_STORE = { "Cache-Control": "private, no-store" };

// GET /api/preferences → Preferences
export async function GET() {
  try {
    const { user, supabase } = await requireUser();
    return Response.json(await getPreferences(supabase, user.id), { headers: NO_STORE });
  } catch (error) {
    return handleRouteError("GET /api/preferences", error);
  }
}

// PATCH /api/preferences Partial<Preferences> → Preferences (the full, saved set). Unknown keys and
// unknown time zones are 400 validation_error.
export async function PATCH(request: Request) {
  try {
    const { user, supabase } = await requireUser();
    const patch = patchPreferencesRequestSchema.parse(await request.json().catch(() => null));
    return Response.json(await updatePreferences(supabase, user.id, patch), { headers: NO_STORE });
  } catch (error) {
    return handleRouteError("PATCH /api/preferences", error);
  }
}
