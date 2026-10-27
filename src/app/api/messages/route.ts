import type { MessagesPage } from "@/types/api";
import { ApiErrorException } from "@/lib/api-error";
import { requireUser } from "@/lib/auth/server";
import { findMeals } from "@/lib/database/meals";
import { hydrateCards, listMessages, mealIdsInCards } from "@/lib/database/messages";
import { messagesQuerySchema } from "@/lib/validation";
import { handleRouteError, json } from "../_lib/route";

// GET /api/messages?before=<message_id>&limit=30 → MessagesPage. Newest page first when `before` is
// omitted; oldest → newest within a page. Meal cards carry the meal as it is now (null once deleted).

export async function GET(request: Request) {
  try {
    const { user, supabase } = await requireUser();
    const params = Object.fromEntries(new URL(request.url).searchParams);
    const query = messagesQuerySchema.parse(params);

    const page = await listMessages(supabase, user.id, { before: query.before, limit: query.limit });
    if (!page) throw new ApiErrorException("not_found", { message: "That message no longer exists." });

    const ids = mealIdsInCards(page.messages);
    const meals = await findMeals(supabase, user.id, ids);
    const response: MessagesPage = {
      messages: hydrateCards(page.messages, new Map(meals.map((meal) => [meal.id, meal]))),
      has_more: page.has_more,
    };
    return json(response);
  } catch (error) {
    return handleRouteError("GET /api/messages", error);
  }
}
