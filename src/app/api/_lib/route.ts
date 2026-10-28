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

// The raw body, read only up to `maxBytes`. A declared Content-Length over the limit is refused before
// anything is read; otherwise reading stops (and the stream is cancelled) at the first chunk past the
// limit. Either way: ApiErrorException("payload_too_large") → 413.
export async function readBodyUpTo(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new ApiErrorException("payload_too_large");
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ApiErrorException("payload_too_large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
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
