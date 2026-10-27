import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiErrorException, apiError, toErrorResponse } from "./api-error";
import { apiErrorSchema } from "./validation/errors";

describe("apiError", () => {
  it.each([
    ["unauthenticated", 401],
    ["not_approved", 403],
    ["validation_error", 400],
    ["payload_too_large", 413],
    ["not_found", 404],
    ["version_conflict", 409],
    ["ai_cap_reached", 429],
    ["ai_unavailable", 503],
    ["internal", 500],
  ] as const)("%s → %i with a contract-shaped body", async (code, status) => {
    const response = apiError(code);
    expect(response.status).toBe(status);
    const body = apiErrorSchema.parse(await response.json());
    expect(body.error.code).toBe(code);
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it("lets callers override message and retryable", async () => {
    const body = await apiError("not_found", { message: "Meal not found", retryable: true }).json();
    expect(body).toEqual({ error: { code: "not_found", message: "Meal not found", retryable: true } });
  });
});

describe("toErrorResponse", () => {
  it("passes through thrown ApiErrorExceptions", () => {
    expect(toErrorResponse(new ApiErrorException("not_approved")).status).toBe(403);
  });

  it("maps ZodErrors to 400 with fields", async () => {
    const result = z.object({ name: z.string() }).safeParse({ name: 1 });
    if (result.success) throw new Error("expected failure");
    const response = toErrorResponse(result.error);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.fields).toHaveProperty("name");
  });

  it("hides unknown errors behind a generic 500", async () => {
    const response = toErrorResponse(new Error("relation \"meals\" does not exist at db.ts:42"));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("relation");
    expect(text).not.toContain("db.ts");
  });
});
