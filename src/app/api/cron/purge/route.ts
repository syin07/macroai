import { createHash, timingSafeEqual } from "node:crypto";
import { apiError } from "@/lib/api-error";
import { createServiceRoleClient } from "@/lib/database/admin";
import { purgeExpired } from "@/lib/database/meals";
import { handleRouteError, json } from "../../_lib/route";

// GET /api/cron/purge — Vercel Cron (vercel.json). Vercel sends `Authorization: Bearer $CRON_SECRET`.
// Hard-deletes meals past their undo window, idempotency keys older than 24 h, and expired
// temporary_uploads rows. Uses the service role: this is the one job that acts across users.

// Constant-time comparison. Hashing first makes both sides the same length, so the comparison itself
// leaks neither the secret nor its length.
function matches(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function isAuthorizedCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("GET /api/cron/purge: CRON_SECRET is not set; refusing to run");
    return false;
  }
  return matches(request.headers.get("authorization") ?? "", `Bearer ${secret}`);
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return apiError("unauthenticated");
  try {
    const purged = await purgeExpired(createServiceRoleClient());
    return json({ purged });
  } catch (error) {
    return handleRouteError("GET /api/cron/purge", error);
  }
}
