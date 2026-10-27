import { expect, it } from "vitest";
import type { ChatMessage } from "@/types/api";
import { messageSource } from "./message-source";

const assistant: ChatMessage = {
  id: "answer",
  client_message_id: null,
  role: "assistant",
  text: "Estimate",
  cards: [],
  had_image: false,
  status: "sent",
  created_at: "2026-10-26T00:00:00Z",
};
it("uses the original user photo marker even though the assistant has no image", () => {
  const user: ChatMessage = {
    ...assistant,
    id: "user",
    role: "user",
    had_image: true,
  };
  expect(messageSource([user, assistant], 1)).toBe("photo");
  expect(messageSource([{ ...user, had_image: false }, assistant], 1)).toBe(
    "text",
  );
});
it("does not invent text provenance at a history page boundary", () => {
  expect(messageSource([assistant], 0)).toBeNull();
});
