import { formatInTimeZone } from "date-fns-tz";
import { z } from "zod";
import { ApiErrorException, toErrorResponse } from "@/lib/api-error";
import { requireUser } from "@/lib/auth/server";
import { loadExport } from "@/lib/database/export";
import { mealsToCsv } from "@/lib/database/export-csv";
import { exportQuerySchema } from "@/lib/validation";
import { isValidTimeZone } from "@/lib/validation/common";

// GET /api/export?format=csv|json&scope=nutrition|account → file download (PRD FR-18,
// shared-contracts §3). scope=account adds chat history, memories, goals and preferences, JSON only
// (exportQuerySchema rejects account + csv). Queries run as the user under RLS, never the service role.

// Error names and messages only: exported content (meal names, chat text) must never reach logs.
function logFailure(error: unknown) {
  if (error instanceof ApiErrorException || error instanceof z.ZodError) return;
  console.error("GET /api/export failed:", error instanceof Error ? `${error.name}: ${error.message}` : "unknown error");
}

export async function GET(request: Request) {
  try {
    const { user, supabase } = await requireUser();
    const query = exportQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));

    const now = new Date();
    const data = await loadExport(supabase, { id: user.id, email: user.email ?? null }, query.scope, now);

    const zone = isValidTimeZone(data.timezone) ? data.timezone : "UTC";
    const filename = `macroai-${query.scope}-${formatInTimeZone(now, zone, "yyyy-MM-dd")}.${query.format}`;
    const body = query.format === "csv" ? mealsToCsv(data.meals, zone) : JSON.stringify(data, null, 2);

    return new Response(body, {
      headers: {
        "Content-Type": query.format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    logFailure(error);
    return toErrorResponse(error);
  }
}
