import { ExtractionOutputError, type ExtractionFailure, type TokenUsage } from "../extraction";

// Settings every adapter uses, so the bake-off compares models under the same limits.

// Cap, not a target: three meals of five foods is ~2K tokens of JSON, plus room for reasoning tokens.
export const EXTRACTION_MAX_OUTPUT_TOKENS = 8192;

export const PROVIDER_TIMEOUT_MS = 30_000;

export type IncompleteStop = Extract<ExtractionFailure, "refusal" | "max_tokens" | "safety">;

// Call before parsing: a refused, truncated, or safety-blocked response isn't malformed JSON, and
// reporting it as such hides the real cause. `detail` is the provider's own reason, for logs.
export function throwIfIncomplete(stop: IncompleteStop | null, detail: string, raw: string, usage: TokenUsage): void {
  if (stop) throw new ExtractionOutputError(`Model stopped early (${stop}): ${detail}`, raw, usage, [], stop);
}
