import { z } from "zod";
import type { ApiError, ErrorCode } from "@/types/api";

export const errorCodeSchema = z.enum([
  "unauthenticated",
  "not_approved",
  "validation_error",
  "payload_too_large",
  "not_found",
  "version_conflict",
  "ai_cap_reached",
  "ai_unavailable",
  "internal",
]) satisfies z.ZodType<ErrorCode>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
    fields: z.record(z.string(), z.string()).optional(),
  }),
}) satisfies z.ZodType<ApiError>;

// Turns a ZodError into the `fields` map of an ApiError: { "meals.0.items.1.grams": "Too big: ..." }.
// Keeps the first message per path.
export function zodErrorToFields(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.map(String).join(".") : "_";
    if (!(key in fields)) fields[key] = issue.message;
  }
  return fields;
}
