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

// The whole multipart body: the image plus room for the text fields and part headers (2,000 chars of
// text is at most 8 KB of UTF-8). The route stops reading past this and answers 413.
export const MAX_CHAT_BODY_BYTES = MAX_IMAGE_BYTES + 64 * 1024;

export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((byte, i) => bytes[offset + i] === byte);

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

// The image's real format from its magic bytes, or null when it's none of JPEG, PNG, or WebP. The
// declared MIME type comes from the client and can't be trusted on its own.
export function sniffImageType(bytes: Uint8Array): AllowedImageType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  return null;
}

// POST /api/ai/analyze-meal — internal/eval route, not part of Ken's contract. `now` pins the clock so
// date-phrase eval cases are reproducible; it only affects the returned proposals, which aren't saved.
export const analyzeMealRequestSchema = z.object({
  text: z.string().trim().min(1).max(MAX_CHAT_TEXT),
  timezone,
  now: isoDateTime.optional(),
});

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
