import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ApiErrorException, toErrorResponse } from "@/lib/api-error";
import { analyzeMeal } from "@/lib/ai/analyze";
import { assertWithinAiCap } from "@/lib/ai/cap";
import { getProvider } from "@/lib/ai/providers";
import { createUsageRecorder } from "@/lib/ai/usage";
import { requireUser } from "@/lib/auth/server";
import { createServiceRoleClient } from "@/lib/database/admin";
import { memoryLoader } from "@/lib/memory/retrieve";
import { createSupabaseNutritionCache } from "@/lib/nutrition/cache";
import { getFood, searchFoods } from "@/lib/nutrition/usda";
import { analyzeMealRequestSchema } from "@/lib/validation";

// POST /api/ai/analyze-meal { text, timezone, now? } → MealAnalysis. Internal and eval only: Ken's UI
// goes through /api/ai/chat. Returns proposals without saving anything.

// Cache writes are an optimization; without the service-role key the cache is read-only.
function cacheWriter(): SupabaseClient | null {
  try {
    return createServiceRoleClient();
  } catch {
    return null;
  }
}

// Error names and messages only: provider errors can carry the model's raw output, which echoes the
// user's meal text, and that must never reach logs.
function logFailure(error: unknown) {
  if (error instanceof z.ZodError) return; // the client's mistake, answered with 400
  const cause = error instanceof ApiErrorException ? error.cause : error;
  if (error instanceof ApiErrorException && cause === undefined) return;
  const summary = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  console.error("POST /api/ai/analyze-meal failed:", summary);
}

export async function POST(request: Request) {
  try {
    const { user, supabase } = await requireUser();
    const body = analyzeMealRequestSchema.parse(await request.json().catch(() => null));
    await assertWithinAiCap(supabase, user.id);

    const analysis = await analyzeMeal(
      { text: body.text, user: { id: user.id, timezone: body.timezone }, now: body.now ? new Date(body.now) : undefined },
      {
        provider: getProvider(),
        lookup: { searchFoods, getFood },
        cache: createSupabaseNutritionCache({ reader: supabase, writer: cacheWriter() }),
        recordUsage: createUsageRecorder(supabase, user.id, "ai/analyze-meal"),
        loadMemories: memoryLoader(supabase),
      },
    );
    return Response.json(analysis, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    logFailure(error);
    return toErrorResponse(error);
  }
}
