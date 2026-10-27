import { z } from "zod";
import type { ChatMessage, ChatResponse, MealCard, MessagesPage } from "@/types/api";
import { isoDateTime, limitParam, timezone, uuid } from "./common";
import { mealProposalSchema, mealSchema } from "./meal";
import { dailySummarySchema } from "./goals";

export const MAX_CHAT_TEXT = 2_000;
export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

// POST /api/ai/chat — the text fields of the multipart form. The image is checked with imageFileSchema.
export const chatFormSchema = z.object({
  client_message_id: uuid,
  text: z
    .string()
    .trim()
    .max(MAX_CHAT_TEXT)
    .optional()
    .transform((value) => (value === "" ? undefined : value)),
  timezone,
});

// The image part. Size failures map to 413 payload_too_large rather than 400; see isImageTooLarge.
export const imageFileSchema = z
  .instanceof(Blob)
  .refine((file) => file.size > 0, { message: "Image is empty" })
  .refine((file) => file.size <= MAX_IMAGE_BYTES, { message: "Image is larger than 1.5 MB" })
  .refine((file) => (ALLOWED_IMAGE_TYPES as readonly string[]).includes(file.type), {
    message: "Image must be JPEG, PNG, or WebP",
  });

export function isImageTooLarge(file: Blob): boolean {
  return file.size > MAX_IMAGE_BYTES;
}

export const mealCardSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("proposal"),
    state: z.enum(["unsaved", "discarded"]),
    proposal: mealProposalSchema,
  }),
  z.object({
    kind: z.literal("meal"),
    meal_id: uuid,
    meal: mealSchema.nullable(),
  }),
]) satisfies z.ZodType<MealCard>;

export const chatMessageSchema = z.object({
  id: uuid,
  client_message_id: uuid.nullable(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  cards: z.array(mealCardSchema),
  had_image: z.boolean(),
  status: z.enum(["sent", "pending", "error"]),
  created_at: isoDateTime,
}) satisfies z.ZodType<ChatMessage>;

export const chatResponseSchema = z.object({
  user_message: chatMessageSchema,
  assistant_message: chatMessageSchema,
  daily_summary: dailySummarySchema.nullable(),
}) satisfies z.ZodType<ChatResponse>;

// GET /api/messages?before&limit
export const messagesQuerySchema = z.object({
  before: uuid.optional(),
  limit: limitParam(30, 100),
});

export const messagesPageSchema = z.object({
  messages: z.array(chatMessageSchema),
  has_more: z.boolean(),
}) satisfies z.ZodType<MessagesPage>;

export const messageIdParamSchema = uuid;
