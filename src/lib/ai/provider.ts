import type { ExtractionResult, TokenUsage } from "./extraction";

// The interchangeable model interface (PRD §5.4). Route handlers and the eval harness only talk to
// AIProvider; each SDK lives behind one adapter in ./providers/.

export type { ExtractionResult, TokenUsage } from "./extraction";

export type ProviderName = "gemini" | "anthropic" | "openai";

export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp";

// Raw bytes passed straight through to the model. Never written to storage or logs (PRD FR-15).
export interface MealImage {
  bytes: Uint8Array;
  mediaType: ImageMediaType;
}

export interface ExtractMealInput {
  text?: string;
  image?: MealImage;
  now: string;        // ISO 8601 with offset; the model resolves "last night" against it
  timezone: string;   // IANA zone
  memories: string[]; // Memory.content strings relevant to this message
}

export interface ExtractMealOutput {
  result: ExtractionResult;
  usage: TokenUsage;
  model: string;
  promptVersion: string;
}

// --- chat with tools (used from B8) ---------------------------------------------------------------

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object for the tool input
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown; // validate with the tool's Zod schema before executing
  // Provider data that must be sent back unchanged with this call (Gemini thought signatures).
  providerData?: string;
}

export interface ToolResult {
  callId: string;
  name: string;
  output: unknown; // serialized to JSON for the model
  isError?: boolean;
}

export type ProviderMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; results: ToolResult[] };

export interface ChatInput {
  system: string;
  messages: ProviderMessage[];
  tools: ToolDef[];
}

export interface ProviderTurn {
  text: string;
  toolCalls: ToolCall[];
  stopReason: "end" | "tool_calls" | "max_tokens" | "refusal" | "other";
  usage: TokenUsage;
  model: string;
}

export interface AIProvider {
  readonly name: ProviderName;
  readonly model: string;
  // Throws ExtractionOutputError when the model answers with something that fails the schema;
  // SDK errors (network, rate limit, 5xx) propagate unchanged.
  extractMeal(input: ExtractMealInput): Promise<ExtractMealOutput>;
  chat(input: ChatInput): Promise<ProviderTurn>;
}

export function imageToBase64(image: MealImage): string {
  return Buffer.from(image.bytes).toString("base64");
}
