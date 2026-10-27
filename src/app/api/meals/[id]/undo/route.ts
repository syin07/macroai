import type { UndoDeleteResponse } from "@/types/api";
import { ApiErrorException } from "@/lib/api-error";
import { requireUser } from "@/lib/auth/server";
import { buildDailySummary } from "@/lib/database/daily";
import { getUserTimezone } from "@/lib/database/profile";
import { localDate } from "@/lib/database/local-day";
import { findMeal, restoreMeal } from "@/lib/database/meals";
import { mealIdParamSchema } from "@/lib/validation";
import { handleRouteError, json } from "../../../_lib/route";

// POST /api/meals/:id/undo → UndoDeleteResponse. 404 once the 10 s window has passed (or if the meal
// isn't pending deletion).

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user, supabase } = await requireUser();
    const mealId = mealIdParamSchema.safeParse((await context.params).id);
    if (!mealId.success) throw new ApiErrorException("not_found");

    const result = await restoreMeal(supabase, mealId.data);
    if (result.status === "not_found") throw new ApiErrorException("not_found");

    const [meal, timezone] = await Promise.all([findMeal(supabase, user.id, mealId.data), getUserTimezone(supabase, user.id)]);
    if (!meal) throw new ApiErrorException("not_found");
    const response: UndoDeleteResponse = {
      meal,
      daily_summary: await buildDailySummary(supabase, user.id, localDate(meal.consumed_at, timezone), timezone),
    };
    return json(response);
  } catch (error) {
    return handleRouteError("POST /api/meals/:id/undo", error);
  }
}
