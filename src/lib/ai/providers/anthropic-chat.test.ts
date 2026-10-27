import { describe, expect, it } from "vitest";
import { chatSystemBlocks, toAnthropicMessage } from "./anthropic";

describe("Anthropic chat request shape", () => {
  it("caches the stable system prompt (and the tools before it) and leaves the per-request context uncached", () => {
    expect(chatSystemBlocks({ system: "RULES", context: "TODAY" })).toEqual([
      { type: "text", text: "RULES", cache_control: { type: "ephemeral" } },
      { type: "text", text: "TODAY" },
    ]);
    expect(chatSystemBlocks({ system: "RULES" })).toHaveLength(1);
  });

  it("replays the model's own content (thinking blocks included) on assistant turns within a tool loop", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "tool_use", id: "t1", name: "get_daily_totals", input: {} },
    ];
    expect(toAnthropicMessage({ role: "assistant", text: "", toolCalls: [], providerContent: content })).toEqual({
      role: "assistant",
      content,
    });
  });

  it("rebuilds assistant turns from text and tool calls when there's no provider content (history)", () => {
    expect(toAnthropicMessage({ role: "assistant", text: "Saved.", toolCalls: [] })).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Saved." }],
    });
  });
});
