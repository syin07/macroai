import { AnthropicProvider } from "./anthropic";
import { GeminiProvider } from "./gemini";
import { OpenAIProvider } from "./openai";
import type { AIProvider, ProviderName } from "../provider";

export const PROVIDER_NAMES: readonly ProviderName[] = ["gemini", "anthropic", "openai"];

export function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

// Server-only: reads API keys from the environment. Model overrides (GEMINI_MODEL, ANTHROPIC_MODEL,
// OPENAI_MODEL) are for the bake-off; production uses the defaults unless set.
export function createProvider(name: ProviderName): AIProvider {
  switch (name) {
    case "gemini":
      return new GeminiProvider({ model: process.env.GEMINI_MODEL || undefined });
    case "anthropic":
      return new AnthropicProvider({ model: process.env.ANTHROPIC_MODEL || undefined });
    case "openai":
      return new OpenAIProvider({ model: process.env.OPENAI_MODEL || undefined });
  }
}

// The production provider, chosen by AI_PROVIDER once the bake-off picks a winner.
export function getProvider(): AIProvider {
  const name = process.env.AI_PROVIDER ?? "";
  if (!isProviderName(name)) {
    throw new Error(`AI_PROVIDER must be one of ${PROVIDER_NAMES.join(", ")}`);
  }
  return createProvider(name);
}
