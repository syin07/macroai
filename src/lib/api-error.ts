import { z } from "zod";
import type { ApiError, ErrorCode } from "@/types/api";
import { zodErrorToFields } from "@/lib/validation/errors";

// Every API route returns errors through this module so the shape and status codes stay consistent
// with the contract (shared-contracts §2, ErrorCode). Messages here are safe to show to the user;
// never put stack traces, SQL, or provider responses in them.

const ERROR_DEFAULTS: Record<ErrorCode, { status: number; message: string; retryable: boolean }> = {
  unauthenticated: { status: 401, message: "Please sign in again.", retryable: false },
  not_approved: { status: 403, message: "This account hasn't been approved.", retryable: false },
  validation_error: { status: 400, message: "Some of that input isn't valid.", retryable: false },
  payload_too_large: { status: 413, message: "That image is too large. Try a smaller one.", retryable: false },
  not_found: { status: 404, message: "We couldn't find that.", retryable: false },
  version_conflict: { status: 409, message: "This was changed somewhere else. Refresh and try again.", retryable: false },
  ai_cap_reached: { status: 429, message: "You've reached today's AI limit. You can still log meals manually.", retryable: false },
  ai_unavailable: { status: 503, message: "The assistant is unavailable right now. Please try again.", retryable: true },
  internal: { status: 500, message: "Something went wrong. Please try again.", retryable: true },
};

export function errorStatus(code: ErrorCode): number {
  return ERROR_DEFAULTS[code].status;
}

export interface ApiErrorOptions {
  message?: string;
  retryable?: boolean;
  fields?: Record<string, string>;
}

export function apiErrorBody(code: ErrorCode, options: ApiErrorOptions = {}): ApiError {
  const defaults = ERROR_DEFAULTS[code];
  return {
    error: {
      code,
      message: options.message ?? defaults.message,
      retryable: options.retryable ?? defaults.retryable,
      ...(options.fields ? { fields: options.fields } : {}),
    },
  };
}

// Build an error Response with the right status code.
export function apiError(code: ErrorCode, options: ApiErrorOptions = {}): Response {
  return Response.json(apiErrorBody(code, options), { status: errorStatus(code) });
}

// Throw from helpers (e.g. requireUser) and let the route's catch turn it into a Response.
export class ApiErrorException extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly options: ApiErrorOptions = {},
  ) {
    super(options.message ?? ERROR_DEFAULTS[code].message);
    this.name = "ApiErrorException";
  }
}

// Map anything thrown in a route handler to a contract error. Unknown errors become a generic 500
// so internals never leak; the caller is responsible for logging them (without meal text or images).
export function toErrorResponse(error: unknown): Response {
  if (error instanceof ApiErrorException) return apiError(error.code, error.options);
  if (error instanceof z.ZodError) return apiError("validation_error", { fields: zodErrorToFields(error) });
  return apiError("internal");
}
