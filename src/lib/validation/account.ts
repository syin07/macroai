import { z } from "zod";
import type { DeleteAccountRequest, Memory, MemoriesResponse, PatchMemoryRequest } from "@/types/api";
import { isoDateTime, text, uuid } from "./common";

// Memories, export, and account deletion (checkpoint H8).

export const memorySchema = z.object({
  id: uuid,
  category: z.enum([
    "frequent_food",
    "portion",
    "brand",
    "dietary",
    "preparation",
    "correction",
    "response_style",
    "assumption",
  ]),
  content: z.string(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
}) satisfies z.ZodType<Memory>;

export const memoriesResponseSchema = z.object({
  memories: z.array(memorySchema),
}) satisfies z.ZodType<MemoriesResponse>;

export const patchMemoryRequestSchema = z.object({
  content: text(500),
}) satisfies z.ZodType<PatchMemoryRequest>;

export const memoryIdParamSchema = uuid;

// GET /api/export?format&scope — account scope includes chat history and memories, JSON only.
export const exportQuerySchema = z
  .object({
    format: z.enum(["csv", "json"]),
    scope: z.enum(["nutrition", "account"]).default("nutrition"),
  })
  .refine((query) => !(query.scope === "account" && query.format === "csv"), {
    message: "Account export is JSON only",
    path: ["format"],
  });

export const deleteAccountRequestSchema = z.object({
  confirm: z.literal("DELETE"),
}) satisfies z.ZodType<DeleteAccountRequest>;
