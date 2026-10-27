import { z } from "zod";
import type { Me, PatchPreferencesRequest, Preferences } from "@/types/api";
import { timezone, uuid } from "./common";

export const preferencesSchema = z.object({
  theme: z.enum(["system", "light", "dark"]),
  save_mode: z.enum(["confirm", "auto"]),
  timezone,
  assistant_style: z.enum(["casual", "detailed"]),
}) satisfies z.ZodType<Preferences>;

// PATCH /api/preferences — unknown keys are rejected so typos don't silently do nothing.
export const patchPreferencesRequestSchema = preferencesSchema
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "Nothing to update" }) satisfies z.ZodType<PatchPreferencesRequest>;

export const meSchema = z.object({
  user_id: uuid,
  email: z.email(),
  display_name: z.string().nullable(),
  approved: z.boolean(),
  onboarding_complete: z.boolean(),
}) satisfies z.ZodType<Me>;
