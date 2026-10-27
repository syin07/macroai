import { z } from "zod";
import { ApiErrorException, toErrorResponse } from "@/lib/api-error";

// Small helpers shared by the API route handlers. (`_lib` is a private folder: not a route.)

export const NO_STORE = { "Cache-Control": "private, no-store" } as const;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

// The body as JSON, or null when it isn't JSON (the route's schema then rejects it with a 400).
export async function readJson(request: Request): Promise<unknown> {
  return request.json().catch(() => null);
}

// Turns any error into a contract ApiError response, logging unexpected ones. Only the error's name and
// message are logged: never request bodies, meal or item names, or provider output.
export function handleRouteError(route: string, error: unknown): Response {
  if (!(error instanceof ApiErrorException) && !(error instanceof z.ZodError)) {
    const summary = error instanceof Error ? `${error.name}: ${error.message}` : "non-Error thrown";
    console.error(`${route} failed:`, summary);
  }
  return toErrorResponse(error);
}
