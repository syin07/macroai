import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import { z } from "zod";
import type { ChatMessage, ChatResponse, MealProposal } from "@/types/api";
import { ApiErrorException, toErrorResponse } from "@/lib/api-error";
import { analyzeMeal } from "@/lib/ai/analyze";
import { assertWithinAiCap } from "@/lib/ai/cap";
import { runChatTurn } from "@/lib/ai/chat";
import { buildContext, HISTORY_MESSAGES, loadContextMemories } from "@/lib/ai/context";
import { createMealStore } from "@/lib/ai/meal-store";
import { createMemoryStore } from "@/lib/ai/memory-store";
import type { ImageMediaType, MealImage } from "@/lib/ai/provider";
import { getProvider } from "@/lib/ai/providers";
import type { MealStore, ToolContext } from "@/lib/ai/tools";
import { createUsageRecorder } from "@/lib/ai/usage";
import { requireUser } from "@/lib/auth/server";
import { createServiceRoleClient } from "@/lib/database/admin";
import {
  DuplicateClientMessageError,
  findReply,
  findUserMessageByClientId,
  getOrCreateConversation,
  hydrateCards,
  insertAssistantMessage,
  insertUserMessage,
  markMessageStatus,
  mealIdsInCards,
  recentMessages,
  toChatMessage,
  type MessageRow,
} from "@/lib/database/messages";
import { getPreferences } from "@/lib/database/preferences";
import { maybeSaveMemory } from "@/lib/memory/extract";
import { createSupabaseNutritionCache } from "@/lib/nutrition/cache";
import { getFood, searchFoods } from "@/lib/nutrition/usda";
import { chatFormSchema, imageFileSchema, isImageTooLarge } from "@/lib/validation";
import { json } from "../../_lib/route";

// POST /api/ai/chat (multipart: client_message_id, text?, image?, timezone) → ChatResponse.
//
// Order matters:
//   1. auth, then validate the form (an oversized image is 413 before anything else runs);
//   2. replay: a client_message_id seen before returns the stored result with no model call;
//   3. the daily AI cap (429 before any model call);
//   4. store the user message (`had_image` only: image bytes go to the model and nowhere else);
//   5. the model ↔ tools loop; 6. store the assistant message with its cards;
//   7. after the response is sent, B13's memory second pass (maybeSaveMemory), which can neither
//      delay nor fail the response.
//
// The image's bytes live only in this request's memory. They are never written to the database,
// storage, or logs (PRD FR-15).

// A first attempt still running (or that died without marking itself) after this long is retried.
const PENDING_TIMEOUT_MS = 90_000;

function formString(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
}

async function readForm(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    throw new ApiErrorException("validation_error", { message: "Send the message as multipart/form-data." });
  }
}

const IMAGE_FIELD_ERROR = (message: string) => new ApiErrorException("validation_error", { fields: { image: message } });

async function readImage(value: FormDataEntryValue | null): Promise<MealImage | undefined> {
  if (value === null || value === "") return undefined;
  if (typeof value === "string") throw IMAGE_FIELD_ERROR("Image must be a file");
  if (isImageTooLarge(value)) throw new ApiErrorException("payload_too_large");
  const parsed = imageFileSchema.safeParse(value);
  if (!parsed.success) throw IMAGE_FIELD_ERROR(parsed.error.issues[0]?.message ?? "Invalid image");
  return { bytes: new Uint8Array(await value.arrayBuffer()), mediaType: value.type as ImageMediaType };
}

// Cache writes are an optimization; without the service-role key the cache is read-only.
function cacheWriter(): SupabaseClient | null {
  try {
    return createServiceRoleClient();
  } catch {
    return null;
  }
}

// Unsaved proposal cards from recent assistant messages, so "save that one" can find them.
function priorProposals(history: ChatMessage[]): Map<string, MealProposal> {
  const proposals = new Map<string, MealProposal>();
  for (const message of history) {
    for (const card of message.cards) {
      if (card.kind === "proposal" && card.state === "unsaved") proposals.set(card.proposal.proposal_id, card.proposal);
    }
  }
  return proposals;
}

async function hydrate(messages: ChatMessage[], meals: MealStore): Promise<ChatMessage[]> {
  const ids = mealIdsInCards(messages);
  return hydrateCards(messages, ids.length > 0 ? await meals.getMeals(ids) : new Map());
}

// The stored result of an earlier request with the same client_message_id. The daily summary is
// today's current one when the reply touched a meal, as in the original response.
async function replay(userRow: MessageRow, reply: MessageRow, meals: MealStore): Promise<ChatResponse> {
  const [userMessage, assistantMessage] = await hydrate(
    [{ ...toChatMessage(userRow), status: "sent" }, toChatMessage(reply)],
    meals,
  );
  const touchedMeal = assistantMessage!.cards.some((card) => card.kind === "meal");
  return {
    user_message: userMessage!,
    assistant_message: assistantMessage!,
    daily_summary: touchedMeal ? await meals.dailySummary() : null,
  };
}

// Names and status codes only: provider errors and database messages can echo the user's meal text.
function logFailure(error: unknown) {
  if (error instanceof z.ZodError) return;
  const cause = error instanceof ApiErrorException ? error.cause : error;
  if (error instanceof ApiErrorException && cause === undefined) return;
  const status = (cause as { status?: unknown } | null)?.status;
  const summary = cause instanceof Error ? cause.name : typeof cause;
  console.error("POST /api/ai/chat failed:", summary, typeof status === "number" ? status : "");
}

export async function POST(request: Request) {
  try {
    const { user, supabase } = await requireUser();

    const form = await readForm(request);
    const fields = chatFormSchema.parse({
      client_message_id: formString(form, "client_message_id"),
      text: formString(form, "text"),
      timezone: formString(form, "timezone"),
    });
    const image = await readImage(form.get("image"));
    if (!fields.text && !image) {
      throw new ApiErrorException("validation_error", { fields: { text: "Send a message or a photo." } });
    }

    // The profile's zone, not the browser's, so "today" matches the daily summary and history.
    const preferences = await getPreferences(supabase, user.id);
    const { timezone } = preferences;
    const now = new Date();
    const meals = createMealStore(supabase, user.id, timezone, () => now);

    // 2. Replay.
    let userRow = await findUserMessageByClientId(supabase, user.id, fields.client_message_id);
    if (userRow) {
      const reply = await findReply(supabase, user.id, userRow.id);
      if (reply) return json(await replay(userRow, reply, meals));
      if (userRow.status === "pending" && now.getTime() - Date.parse(userRow.created_at) < PENDING_TIMEOUT_MS) {
        throw new ApiErrorException("ai_unavailable", { message: "Still working on that message. Try again in a moment." });
      }
      // The first attempt failed: run it again for the stored message, without a second row.
    }

    // 3. Cap, before any model call.
    await assertWithinAiCap(supabase, user.id, { now });

    // Context from what's already saved (the current message isn't stored yet). Totals and memories
    // are best-effort: without them the model is told to use its tools, or does without.
    const [history, today, memories] = await Promise.all([
      recentMessages(supabase, user.id, HISTORY_MESSAGES),
      meals.dailySummary().catch(() => null),
      loadContextMemories(supabase, user.id, userRow ? userRow.content : fields.text),
    ]);

    // 4. The user message.
    const conversationId = await getOrCreateConversation(supabase, user.id);
    if (!userRow) {
      try {
        userRow = await insertUserMessage(supabase, user.id, {
          conversationId,
          clientMessageId: fields.client_message_id,
          text: fields.text ?? "",
          hadImage: image !== undefined,
        });
      } catch (error) {
        // A concurrent request with the same ID got there first.
        if (!(error instanceof DuplicateClientMessageError)) throw error;
        throw new ApiErrorException("ai_unavailable", { message: "Still working on that message. Try again in a moment." });
      }
    }
    const messageText = userRow.content || undefined;

    // 5. The tool loop.
    const provider = getProvider();
    const recordUsage = createUsageRecorder(supabase, user.id, "ai/chat");
    const toolContext: ToolContext = {
      userId: user.id,
      supabase,
      now,
      timezone,
      saveMode: preferences.save_mode,
      image,
      analyze: (input) =>
        analyzeMeal(
          { text: input.text, image: input.image, user: { id: user.id, timezone }, now },
          {
            provider,
            lookup: { searchFoods, getFood },
            cache: createSupabaseNutritionCache({ reader: supabase, writer: cacheWriter() }),
            recordUsage,
          },
        ),
      lookup: { searchFoods, getFood },
      meals,
      memory: createMemoryStore(supabase, user.id, { userMessage: userRow.content, sourceMessageId: userRow.id }),
      priorProposals: priorProposals(history),
    };
    const chat = buildContext({
      now,
      timezone,
      preferences,
      history,
      today,
      memories,
      message: { text: messageText, hasImage: image !== undefined },
    });

    let turn;
    try {
      turn = await runChatTurn(chat, toolContext, { provider, recordUsage });
    } catch (error) {
      await markMessageStatus(supabase, user.id, userRow.id, "error").catch(() => null);
      throw error;
    }

    // 6. The assistant message, then the user message is marked sent.
    const { state } = turn;
    const assistantRow = await insertAssistantMessage(supabase, user.id, {
      conversationId,
      replyTo: userRow.id,
      text: turn.text,
      cards: state.cards,
      relatedMealId: state.relatedMealId,
      tools: state.tools,
    });
    const sentRow = (await markMessageStatus(supabase, user.id, userRow.id, "sent")) ?? userRow;

    // 7. Memory second pass, after the response is sent. Skipped when the model already saved or
    // deleted a memory this turn (the user was explicit; a second call would only find a duplicate).
    // maybeSaveMemory never throws; the catch is belt and braces.
    if (!state.tools.some((t) => t.ok && (t.name === "save_user_memory" || t.name === "delete_user_memory"))) {
      const memoryTurn = { userMessage: userRow.content, assistantReply: turn.text, sourceMessageId: userRow.id };
      after(() => maybeSaveMemory({ supabase, userId: user.id, ...memoryTurn }, { provider }).catch(() => undefined));
    }

    const response: ChatResponse = {
      user_message: { ...toChatMessage(sentRow), status: "sent" },
      // Cards straight from this turn: they already hold the current meal data.
      assistant_message: { ...toChatMessage(assistantRow), cards: state.cards },
      daily_summary: state.mealChanged ? await meals.dailySummary() : null,
    };
    return json(response);
  } catch (error) {
    logFailure(error);
    return toErrorResponse(error);
  }
}
