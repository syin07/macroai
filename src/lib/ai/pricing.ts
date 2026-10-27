import type { TokenUsage } from "./extraction";

// USD per million tokens. Sources: PRD Appendix A.1 (October 2026). Re-check the provider's pricing
// page before relying on these; null means "not confirmed yet" and cost is reported as unknown.
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const MODEL_PRICES: Record<string, ModelPrice | null> = {
  "gemini-3.1-flash-lite": { inputPerMTok: 0.25, outputPerMTok: 1.5 },
  "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5 },
  // TODO(B4): confirm OpenAI mini-tier pricing on openai.com/api/pricing before the bake-off.
  "gpt-5.4-mini": null,
};

export function costUsd(model: string, usage: TokenUsage): number | null {
  const price = MODEL_PRICES[model];
  if (!price) return null;
  return (usage.inputTokens * price.inputPerMTok + usage.outputTokens * price.outputPerMTok) / 1_000_000;
}
