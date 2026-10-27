import type { ApiError, ErrorCode } from "@/types/api";

export class ApiClientError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly status = 0,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export interface RequestOptions {
  headers?: HeadersInit;
  signal?: AbortSignal;
  responseType?: "json" | "blob";
  mock?: boolean;
  redirectOnAuthError?: boolean;
}

export function isMockMode() {
  return process.env.NEXT_PUBLIC_USE_MOCKS === "1";
}

// During integration, opt individual calls out of mock mode with { mock: false }.
export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  const multipart = body instanceof FormData;
  if (body !== undefined && !multipart)
    headers.set("Content-Type", "application/json");
  const init: RequestInit = {
    method,
    headers,
    credentials: "same-origin",
    signal: options.signal,
    body:
      body === undefined ? undefined : multipart ? body : JSON.stringify(body),
  };
  let response: Response;
  try {
    if (options.mock ?? isMockMode()) {
      const { mockApi } = await import("@/mocks/server");
      response = await mockApi.handle(
        new Request(`http://macroai.mock${path}`, init),
      );
    } else {
      response = await fetch(path, init);
    }
  } catch (error) {
    if (
      options.signal?.aborted ||
      (error instanceof Error && error.name === "AbortError")
    )
      throw error;
    throw new ApiClientError(
      "internal",
      "Unable to connect. Please try again.",
      true,
    );
  }
  if (!response.ok) {
    let payload: ApiError | undefined;
    try {
      const value: unknown = await response.json();
      const { apiErrorSchema } = await import("@/lib/validation/errors");
      const result = apiErrorSchema.safeParse(value);
      if (result.success) payload = result.data;
    } catch {
      /* A proxy can return HTML instead of the API error shape. */
    }
    const error = payload?.error;
    if (
      typeof window !== "undefined" &&
      options.redirectOnAuthError !== false
    ) {
      // This transport runs outside React. A document navigation also clears stale private query caches.
      if (response.status === 401 && window.location.pathname !== "/sign-in") {
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign("/sign-in");
      }
      if (
        response.status === 403 &&
        error?.code === "not_approved" &&
        window.location.pathname !== "/not-approved"
      ) {
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign("/not-approved");
      }
    }
    throw new ApiClientError(
      error?.code ?? "internal",
      error?.message ?? "Something went wrong. Please try again.",
      error?.retryable ?? response.status >= 500,
      response.status,
      error?.fields,
    );
  }
  if (response.status === 204) return undefined as T;
  if (options.responseType === "blob") return (await response.blob()) as T;
  return (await response.json()) as T;
}

export function queryString(
  values: Record<string, string | number | undefined>,
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}
