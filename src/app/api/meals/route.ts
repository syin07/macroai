import type { MealsPage, SaveMealsResponse } from "@/types/api";
import { ApiErrorException } from "@/lib/api-error";
import { requireUser } from "@/lib/auth/server";
import { buildDailySummary, todayIn } from "@/lib/database/daily";
import { getUserTimezone } from "@/lib/database/profile";
import { localDate, startOfLocalDay, addDays } from "@/lib/database/local-day";
import { findMeals, listMeals, saveMeals, type PreparedMeal } from "@/lib/database/meals";
import { OversizedItemError, recalculateMeal } from "@/lib/nutrition/recalc";
import { idempotencyKeySchema, mealsQuerySchema, saveMealsRequestSchema } from "@/lib/validation";
import { handleRouteError, json, readJson } from "../_lib/route";

// POST /api/meals (Idempotency-Key header) → 201 SaveMealsResponse
// GET  /api/meals?from&to&q&cursor&limit → MealsPage

export async function POST(request: Request) {
  try {
    const { user, supabase } = await requireUser();

    const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
    if (!key.success) {
      throw new ApiErrorException("validation_error", {
        message: "An Idempotency-Key header (UUID) is required.",
        fields: { "Idempotency-Key": "Must be a UUID" },
      });
    }
    const body = saveMealsRequestSchema.parse(await readJson(request));

    // Never trust client macros or totals: recalculate every meal server-side.
    const prepared: PreparedMeal[] = body.meals.map((meal, mealIndex) => {
      try {
        const { items, totals } = recalculateMeal(meal.items);
        return { name: meal.name, consumed_at: meal.consumed_at, source_type: meal.source_type, items, totals };
      } catch (error) {
        if (!(error instanceof OversizedItemError)) throw error;
        throw new ApiErrorException("validation_error", {
          fields: { [`meals.${mealIndex}.items.${error.index}.grams`]: "That amount is too large." },
        });
      }
    });

    // A retry with the same key writes nothing and returns the meals the first request saved.
    const { replayed, mealIds } = await saveMeals(supabase, key.data, prepared);
    const [meals, timezone] = await Promise.all([findMeals(supabase, user.id, mealIds), getUserTimezone(supabase, user.id)]);

    // One summary per response (contract): today's if any saved meal is today, else the first meal's day.
    const today = todayIn(timezone);
    const days = (meals.length > 0 ? meals : prepared).map((meal) => localDate(meal.consumed_at, timezone));
    const date = days.includes(today) ? today : (days[0] ?? today);

    const response: SaveMealsResponse = {
      meals,
      daily_summary: await buildDailySummary(supabase, user.id, date, timezone),
    };
    return json(response, 201, replayed ? { "Idempotency-Replayed": "true" } : {});
  } catch (error) {
    return handleRouteError("POST /api/meals", error);
  }
}

export async function GET(request: Request) {
  try {
    const { user, supabase } = await requireUser();
    const params = Object.fromEntries(new URL(request.url).searchParams);
    const query = mealsQuerySchema.parse(params);
    const timezone = query.from || query.to ? await getUserTimezone(supabase, user.id) : "UTC";

    const page: MealsPage = await listMeals(supabase, {
      // from/to are local dates in the user's zone; `to` is inclusive, so the bound is the next midnight.
      from: query.from ? startOfLocalDay(query.from, timezone) : null,
      to: query.to ? startOfLocalDay(addDays(query.to, 1), timezone) : null,
      q: query.q ? query.q : null,
      cursor: query.cursor ?? null,
      limit: query.limit,
    });
    return json(page);
  } catch (error) {
    return handleRouteError("GET /api/meals", error);
  }
}
