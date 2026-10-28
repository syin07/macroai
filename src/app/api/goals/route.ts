import { requireUser } from "@/lib/auth/server";
import { getGoalsOn, saveGoals } from "@/lib/database/goals";
import { userToday } from "@/lib/database/profile";
import { putGoalsRequestSchema } from "@/lib/validation";
import { handleRouteError } from "../_lib/route";

const NO_STORE = { "Cache-Control": "private, no-store" };

// GET /api/goals → NutritionGoals | null: the targets in effect today in the user's time zone.
export async function GET() {
  try {
    const { user, supabase } = await requireUser();
    const goals = await getGoalsOn(supabase, user.id, await userToday(supabase, user.id));
    return Response.json(goals, { headers: NO_STORE });
  } catch (error) {
    return handleRouteError("GET /api/goals", error);
  }
}

// PUT /api/goals { calories, protein_g, carbs_g, fat_g } → NutritionGoals. New targets apply from today
// (user's time zone); earlier days keep the targets they had.
export async function PUT(request: Request) {
  try {
    const { user, supabase } = await requireUser();
    const body = putGoalsRequestSchema.parse(await request.json().catch(() => null));
    const goals = await saveGoals(supabase, user.id, await userToday(supabase, user.id), body);
    return Response.json(goals, { headers: NO_STORE });
  } catch (error) {
    return handleRouteError("PUT /api/goals", error);
  }
}
