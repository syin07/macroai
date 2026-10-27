import type { DailySummary } from "@/types/api";
import { requireUser } from "@/lib/auth/server";
import { buildDailySummary, todayIn } from "@/lib/database/daily";
import { getUserTimezone } from "@/lib/database/profile";
import { dailyQuerySchema } from "@/lib/validation";
import { handleRouteError, json } from "../../_lib/route";

// GET /api/nutrition/daily?date=YYYY-MM-DD → DailySummary (defaults to today in the user's time zone).

export async function GET(request: Request) {
  try {
    const { user, supabase } = await requireUser();
    const query = dailyQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const timezone = await getUserTimezone(supabase, user.id);
    const summary: DailySummary = await buildDailySummary(supabase, user.id, query.date ?? todayIn(timezone), timezone);
    return json(summary);
  } catch (error) {
    return handleRouteError("GET /api/nutrition/daily", error);
  }
}
