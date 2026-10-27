import { z } from "zod";
import { ApiErrorException, toErrorResponse } from "@/lib/api-error";
import { requireUser } from "@/lib/auth/server";
import { suggestGoals } from "@/lib/nutrition/goals";
import { suggestGoalsRequestSchema } from "@/lib/validation";

// POST /api/goals/suggest { age, height_cm, weight_kg, sex, activity, goal, target_weight_kg? }
// → { suggested, explanation }. Pure calculation; saves nothing (the client saves via PUT /api/goals).
// Body stats are health data: never log them.
export async function POST(request: Request) {
  try {
    await requireUser();
    const body = suggestGoalsRequestSchema.parse(await request.json().catch(() => null));
    return Response.json(suggestGoals(body), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (!(error instanceof ApiErrorException || error instanceof z.ZodError)) {
      console.error("POST /api/goals/suggest failed:", error instanceof Error ? error.name : "unknown error");
    }
    return toErrorResponse(error);
  }
}
