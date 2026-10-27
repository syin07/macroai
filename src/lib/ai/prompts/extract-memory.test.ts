import { describe, expect, it } from "vitest";
import { memorySchema } from "@/lib/validation";
import {
  EXTRACT_MEMORY_SYSTEM_PROMPT,
  MAX_USER_MESSAGE_CHARS,
  MEMORY_CATEGORIES,
  PROPOSE_MEMORY_TOOL,
  PROPOSE_MEMORY_TOOL_NAME,
  buildExtractMemoryUserText,
} from "./extract-memory";

describe("extract-memory prompt", () => {
  it("offers exactly the contract's memory categories", () => {
    expect([...MEMORY_CATEGORIES].sort()).toEqual([...memorySchema.shape.category.options].sort());
    const category = (PROPOSE_MEMORY_TOOL.parameters.properties as Record<string, { enum: unknown[] }>).category!;
    expect(category.enum).toEqual([...MEMORY_CATEGORIES, null]);
  });

  it("names the tool it tells the model to call", () => {
    expect(PROPOSE_MEMORY_TOOL.name).toBe(PROPOSE_MEMORY_TOOL_NAME);
    expect(EXTRACT_MEMORY_SYSTEM_PROMPT).toContain(PROPOSE_MEMORY_TOOL_NAME);
  });

  it("lists saved memories by ref and fences the exchange", () => {
    const text = buildExtractMemoryUserText({
      userMessage: "  my usual shake  ",
      assistantReply: "Logged it.",
      memories: [{ ref: "m1", category: "frequent_food", content: "Usual shake: Fairlife Core Power 26g" }],
    });
    expect(text).toBe(
      [
        "Saved memories:",
        "m1 [frequent_food] Usual shake: Fairlife Core Power 26g",
        "",
        "User message:",
        "<<<",
        "my usual shake",
        ">>>",
        "",
        "Assistant reply:",
        "<<<",
        "Logged it.",
        ">>>",
      ].join("\n"),
    );
  });

  it("says (none) without memories and clips a long message", () => {
    const text = buildExtractMemoryUserText({ userMessage: "y".repeat(MAX_USER_MESSAGE_CHARS + 10), assistantReply: "", memories: [] });
    expect(text).toContain("Saved memories:\n(none)");
    expect(text).toContain(`${"y".repeat(MAX_USER_MESSAGE_CHARS)}…`);
    expect(text).not.toContain("y".repeat(MAX_USER_MESSAGE_CHARS + 1));
  });
});
