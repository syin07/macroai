import type { AIProvider, ChatInput, ExtractMealInput, ExtractMealOutput, ProviderTurn } from "@/lib/ai/provider";
import { PROPOSE_MEMORY_TOOL_NAME } from "@/lib/ai/prompts/extract-memory";

// A provider that answers the memory pass with scripted propose_memory tool calls and records every
// request. No network, no spend.

export const FAKE_MODEL = "claude-haiku-5-5";
export const FAKE_USAGE = { inputTokens: 700, outputTokens: 60 };

export type ProposalInput = Record<string, unknown>;

export function proposal(fields: ProposalInput = {}): ProposalInput {
  return {
    has_memory: true,
    category: "frequent_food",
    content: "Usual shake: Fairlife Core Power 26g, 1 bottle",
    explicit: false,
    evidence: null,
    updates: null,
    ...fields,
  };
}

export const NO_MEMORY: ProposalInput = {
  has_memory: false,
  category: null,
  content: null,
  explicit: false,
  evidence: null,
  updates: null,
};

// A reply is a tool input (→ one propose_memory call), a full turn, or an Error to throw.
export type FakeReply = ProposalInput | Partial<ProviderTurn> | Error;

export class FakeMemoryProvider implements AIProvider {
  readonly name = "anthropic" as const;
  readonly model = FAKE_MODEL;
  readonly chats: ChatInput[] = [];
  readonly extractions: ExtractMealInput[] = [];
  // Stands in for the extraction model in end-to-end checks (see eval.test.ts).
  onExtract: ((input: ExtractMealInput) => ExtractMealOutput) | null = null;

  constructor(private readonly replies: FakeReply[] = []) {}

  async chat(input: ChatInput): Promise<ProviderTurn> {
    this.chats.push(input);
    const reply = this.replies[Math.min(this.chats.length, this.replies.length) - 1] ?? NO_MEMORY;
    if (reply instanceof Error) throw reply;
    const base: ProviderTurn = { text: "", toolCalls: [], stopReason: "tool_calls", usage: FAKE_USAGE, model: FAKE_MODEL };
    if ("toolCalls" in reply || "text" in reply) return { ...base, ...(reply as Partial<ProviderTurn>) };
    return { ...base, toolCalls: [{ id: `call-${this.chats.length}`, name: PROPOSE_MEMORY_TOOL_NAME, input: reply }] };
  }

  async extractMeal(input: ExtractMealInput): Promise<ExtractMealOutput> {
    this.extractions.push(input);
    if (!this.onExtract) throw new Error("FakeMemoryProvider: no onExtract set");
    return this.onExtract(input);
  }
}
