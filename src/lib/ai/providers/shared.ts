// Settings every adapter uses, so the bake-off compares models under the same limits.

// Cap, not a target: three meals of five foods is ~2K tokens of JSON, plus room for reasoning tokens.
export const EXTRACTION_MAX_OUTPUT_TOKENS = 8192;

export const PROVIDER_TIMEOUT_MS = 30_000;
