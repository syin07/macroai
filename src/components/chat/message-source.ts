import type { ChatMessage } from "@/types/api";

export function messageSource(
  messages: ChatMessage[],
  index: number,
): "text" | "photo" | null {
  if (messages[index]?.had_image) return "photo";
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    if (messages[cursor].role === "user")
      return messages[cursor].had_image ? "photo" : "text";
  }
  return null;
}
