import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChatMessage, Meal, MealCard } from "@/types/api";
import { mealCardSchema } from "@/lib/validation/chat";

// Chat history (conversations + messages). Every function takes the RLS-bound client from
// requireUser() and the session user's ID. Message rows hold text, cards, and `had_image`; image bytes
// are never passed in here, so they can't be stored (PRD FR-15).

const MESSAGE_COLUMNS = "id, client_message_id, role, content, cards, had_image, status, created_at";

export interface MessageRow {
  id: string;
  client_message_id: string | null;
  role: "user" | "assistant" | "tool";
  content: string;
  cards: unknown;
  had_image: boolean;
  status: "sent" | "pending" | "error" | "deleted";
  created_at: string;
}

// Postgres unique_violation: a concurrent request inserted the same client_message_id first.
export class DuplicateClientMessageError extends Error {
  constructor() {
    super("client_message_id already used");
    this.name = "DuplicateClientMessageError";
  }
}

// Stored cards are re-validated on read; anything malformed is dropped rather than failing the page.
function parseCards(value: unknown): MealCard[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((card) => {
    const parsed = mealCardSchema.safeParse(card);
    return parsed.success ? [parsed.data] : [];
  });
}

export function toChatMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    client_message_id: row.client_message_id,
    role: row.role === "assistant" ? "assistant" : "user",
    text: row.content,
    cards: parseCards(row.cards),
    had_image: row.had_image,
    status: row.status === "pending" || row.status === "error" ? row.status : "sent",
    created_at: row.created_at,
  };
}

// Meal cards are stored without the meal (it would go stale); callers fill it in with hydrateCards.
export function cardsForStorage(cards: MealCard[]): MealCard[] {
  return cards.map((card) => (card.kind === "meal" ? { kind: "meal", meal_id: card.meal_id, meal: null } : card));
}

export function mealIdsInCards(messages: ChatMessage[]): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const card of message.cards) if (card.kind === "meal") ids.add(card.meal_id);
  }
  return [...ids];
}

// Puts current meal data into every `kind: "meal"` card; `meal: null` when the meal no longer exists.
export function hydrateCards(messages: ChatMessage[], meals: ReadonlyMap<string, Meal>): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    cards: message.cards.map((card) =>
      card.kind === "meal" ? { ...card, meal: meals.get(card.meal_id) ?? null } : card,
    ),
  }));
}

// --- Conversations ---

// MVP has one conversation per user: the most recently updated one, created on first use.
export async function getOrCreateConversation(supabase: SupabaseClient, userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("conversations")
    .select("id")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`conversations select failed: ${error.message}`);
  if (data) return (data as { id: string }).id;

  const { data: created, error: insertError } = await supabase
    .from("conversations")
    .insert({ user_id: userId })
    .select("id")
    .single();
  if (insertError) throw new Error(`conversations insert failed: ${insertError.message}`);
  return (created as { id: string }).id;
}

// --- Reads ---

export async function findUserMessageByClientId(
  supabase: SupabaseClient,
  userId: string,
  clientMessageId: string,
): Promise<MessageRow | null> {
  const { data, error } = await supabase
    .from("messages")
    .select(MESSAGE_COLUMNS)
    .eq("user_id", userId)
    .eq("client_message_id", clientMessageId)
    .maybeSingle();
  if (error) throw new Error(`messages select failed: ${error.message}`);
  return (data as MessageRow | null) ?? null;
}

// The assistant message written in reply to `userMessageId` (linked through tool_payload.reply_to).
export async function findReply(
  supabase: SupabaseClient,
  userId: string,
  userMessageId: string,
): Promise<MessageRow | null> {
  const { data, error } = await supabase
    .from("messages")
    .select(MESSAGE_COLUMNS)
    .eq("user_id", userId)
    .eq("role", "assistant")
    .eq("tool_payload->>reply_to", userMessageId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`messages select failed: ${error.message}`);
  return (data as MessageRow | null) ?? null;
}

export interface MessagePageQuery {
  before?: string; // message ID; the page holds messages strictly older than it
  limit: number;
}

// GET /api/messages. Cursor is (created_at, id), newest first; returned oldest → newest within the
// page. `null` when `before` doesn't name one of the user's messages.
export async function listMessages(
  supabase: SupabaseClient,
  userId: string,
  { before, limit }: MessagePageQuery,
): Promise<{ messages: ChatMessage[]; has_more: boolean } | null> {
  let query = supabase
    .from("messages")
    .select(MESSAGE_COLUMNS)
    .eq("user_id", userId)
    .in("role", ["user", "assistant"])
    .neq("status", "deleted");

  if (before) {
    const { data: cursor, error } = await supabase
      .from("messages")
      .select("id, created_at")
      .eq("user_id", userId)
      .eq("id", before)
      .maybeSingle();
    if (error) throw new Error(`messages select failed: ${error.message}`);
    if (!cursor) return null;
    const { id, created_at } = cursor as { id: string; created_at: string };
    // Quoted: timestamps contain '.', ':' and '+', which PostgREST's logic-tree syntax reserves.
    query = query.or(`created_at.lt."${created_at}",and(created_at.eq."${created_at}",id.lt.${id})`);
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (error) throw new Error(`messages select failed: ${error.message}`);

  const rows = (data ?? []) as MessageRow[];
  return {
    messages: rows.slice(0, limit).reverse().map(toChatMessage),
    has_more: rows.length > limit,
  };
}

// The last `limit` sent messages, oldest → newest, for the model's context.
export async function recentMessages(supabase: SupabaseClient, userId: string, limit: number): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from("messages")
    .select(MESSAGE_COLUMNS)
    .eq("user_id", userId)
    .in("role", ["user", "assistant"])
    .eq("status", "sent")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`messages select failed: ${error.message}`);
  return ((data ?? []) as MessageRow[]).reverse().map(toChatMessage);
}

// --- Writes ---

export interface NewUserMessage {
  conversationId: string;
  clientMessageId: string;
  text: string;
  hadImage: boolean; // a flag only: there is deliberately no field for image data
}

// Inserted as `pending`; markMessageStatus() moves it to `sent` or `error` when the turn ends.
export async function insertUserMessage(
  supabase: SupabaseClient,
  userId: string,
  message: NewUserMessage,
): Promise<MessageRow> {
  const { data, error } = await supabase
    .from("messages")
    .insert({
      conversation_id: message.conversationId,
      user_id: userId,
      client_message_id: message.clientMessageId,
      role: "user",
      content: message.text,
      had_image: message.hadImage,
      status: "pending",
    })
    .select(MESSAGE_COLUMNS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") throw new DuplicateClientMessageError();
    throw new Error(`messages insert failed: ${error.message}`);
  }
  return data as MessageRow;
}

export interface NewAssistantMessage {
  conversationId: string;
  replyTo: string;          // the user message's ID; how a replayed request finds this reply
  text: string;
  cards: MealCard[];
  relatedMealId: string | null;
  tools: Array<{ name: string; ok: boolean }>; // which tools ran, for debugging; no arguments
}

export async function insertAssistantMessage(
  supabase: SupabaseClient,
  userId: string,
  message: NewAssistantMessage,
): Promise<MessageRow> {
  const { data, error } = await supabase
    .from("messages")
    .insert({
      conversation_id: message.conversationId,
      user_id: userId,
      role: "assistant",
      content: message.text,
      cards: cardsForStorage(message.cards),
      related_meal_id: message.relatedMealId,
      tool_payload: { reply_to: message.replyTo, tools: message.tools },
      had_image: false,
      status: "sent",
    })
    .select(MESSAGE_COLUMNS)
    .single();
  if (error) throw new Error(`messages insert failed: ${error.message}`);
  return data as MessageRow;
}

export async function markMessageStatus(
  supabase: SupabaseClient,
  userId: string,
  messageId: string,
  status: "sent" | "error",
): Promise<MessageRow | null> {
  const { data, error } = await supabase
    .from("messages")
    .update({ status })
    .eq("user_id", userId)
    .eq("id", messageId)
    .select(MESSAGE_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`messages update failed: ${error.message}`);
  return (data as MessageRow | null) ?? null;
}

// DELETE /api/messages/:id. Removes the message only; meals it created are untouched. false if the
// user has no such message.
export async function deleteMessage(supabase: SupabaseClient, userId: string, messageId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("messages")
    .delete()
    .eq("user_id", userId)
    .eq("id", messageId)
    .select("id");
  if (error) throw new Error(`messages delete failed: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}
