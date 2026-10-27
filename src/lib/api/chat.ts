import type { ChatResponse, MessagesPage } from "@/types/api";
import { request, queryString, type RequestOptions } from "./client";

// Keep this draft after a failed send. Retrying it reuses client_message_id.
export interface ChatDraft {
  client_message_id: string;
  text?: string;
  image?: Blob;
  timezone: string;
}
export function createChatDraft(
  input: Omit<ChatDraft, "client_message_id" | "timezone"> & {
    timezone?: string;
  },
): ChatDraft {
  return {
    ...input,
    client_message_id: crypto.randomUUID(),
    timezone:
      input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
export function sendChat(draft: ChatDraft, options?: RequestOptions) {
  const form = new FormData();
  form.set("client_message_id", draft.client_message_id);
  form.set("timezone", draft.timezone);
  if (draft.text !== undefined) form.set("text", draft.text);
  if (draft.image) form.set("image", draft.image, "meal.jpg");
  return request<ChatResponse>("POST", "/api/ai/chat", form, options);
}
export function getMessages(
  query: { before?: string; limit?: number } = {},
  options?: RequestOptions,
) {
  return request<MessagesPage>(
    "GET",
    `/api/messages${queryString(query)}`,
    undefined,
    options,
  );
}
export function deleteMessage(id: string, options?: RequestOptions) {
  return request<void>(
    "DELETE",
    `/api/messages/${encodeURIComponent(id)}`,
    undefined,
    options,
  );
}
