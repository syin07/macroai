import type { DeleteMealResponse, UpdateMealResponse } from "@/types/api";
import { ApiErrorException } from "@/lib/api-error";
import { requireUser } from "@/lib/auth/server";
import { buildDailySummariesFor, buildDailySummary } from "@/lib/database/daily";
import { getUserTimezone } from "@/lib/database/profile";
import { localDate } from "@/lib/database/local-day";
import { editMeal } from "@/lib/database/meal-writes";
import { deleteMeal, findMeal } from "@/lib/database/meals";
import { mealIdParamSchema, updateMealRequestSchema } from "@/lib/validation";
import { handleRouteError, json, readJson } from "../../_lib/route";

// GET    /api/meals/:id → Meal
// PATCH  /api/meals/:id → UpdateMealResponse (409 version_conflict on a stale version)
// DELETE /api/meals/:id → DeleteMealResponse (soft delete; undo within 10 s)

interface Context {
  params: Promise<{ id: string }>;
}

// A malformed id can't match any meal, so it's a 404 like any other missing meal.
async function mealIdFrom(context: Context): Promise<string> {
  const parsed = mealIdParamSchema.safeParse((await context.params).id);
  if (!parsed.success) throw new ApiErrorException("not_found");
  return parsed.data;
}

const notFound = () => new ApiErrorException("not_found");

export async function GET(_request: Request, context: Context) {
  try {
    const { user, supabase } = await requireUser();
    const meal = await findMeal(supabase, user.id, await mealIdFrom(context));
    if (!meal) throw notFound();
    return json(meal);
  } catch (error) {
    return handleRouteError("GET /api/meals/:id", error);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const { user, supabase } = await requireUser();
    const mealId = await mealIdFrom(context);
    const body = updateMealRequestSchema.parse(await readJson(request));

    const { before, meal } = await editMeal(supabase, user.id, mealId, body);
    const timezone = await getUserTimezone(supabase, user.id);
    const response: UpdateMealResponse = {
      meal,
      // Old day first, then the new day if consumed_at moved across midnight.
      daily_summaries: await buildDailySummariesFor(supabase, user.id, [before.consumed_at, meal.consumed_at], timezone),
    };
    return json(response);
  } catch (error) {
    return handleRouteError("PATCH /api/meals/:id", error);
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const { user, supabase } = await requireUser();
    const result = await deleteMeal(supabase, await mealIdFrom(context));
    if (result.status === "not_found") throw notFound();

    const timezone = await getUserTimezone(supabase, user.id);
    const response: DeleteMealResponse = {
      undo_until: new Date(result.undo_until).toISOString(),
      daily_summary: await buildDailySummary(supabase, user.id, localDate(result.consumed_at, timezone), timezone),
    };
    return json(response);
  } catch (error) {
    return handleRouteError("DELETE /api/meals/:id", error);
  }
}
