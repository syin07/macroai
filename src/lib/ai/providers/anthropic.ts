import Anthropic from "@anthropic-ai/sdk";
import { EXTRACTION_MAX_OUTPUT_TOKENS, PROVIDER_TIMEOUT_MS, throwIfIncomplete, type IncompleteStop } from "./shared";
import { extractionJsonSchema, parseExtractionOutput, type TokenUsage } from "../extraction";
import { EXTRACT_MEAL_PROMPT_VERSION, EXTRACT_MEAL_SYSTEM_PROMPT, buildExtractMealUserText } from "../prompts/extract-meal";
import {
  imageToBase64,
  type AIProvider,
  type ChatInput,
  type ExtractMealInput,
  type ExtractMealOutput,
  type ProviderMessage,
  type ProviderTurn,
} from "../provider";

export const ANTHROPIC_DEFAULT_MODEL = "claude-haiku-5-5";

export interface AnthropicProviderOptions {
  apiKey?: string; // defaults to ANTHROPIC_API_KEY
  model?: string;
}

// Claude via the Messages API. Extraction uses structured outputs (output_config.format), which
// constrains decoding to the JSON Schema.
export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic" as const;
  readonly model: string;
  private readonly client: Anthropic;

  constructor(options: AnthropicProviderOptions = {}) {
    this.model = options.model ?? ANTHROPIC_DEFAULT_MODEL;
    this.client = new Anthropic({ apiKey: options.apiKey, timeout: PROVIDER_TIMEOUT_MS });
  }

  async extractMeal(input: ExtractMealInput): Promise<ExtractMealOutput> {
    const content: Anthropic.ContentBlockParam[] = [];
    if (input.image) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: input.image.mediaType, data: imageToBase64(input.image) },
      });
    }
    content.push({ type: "text", text: buildExtractMealUserText(input) });

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: EXTRACTION_MAX_OUTPUT_TOKENS,
      system: EXTRACT_MEAL_SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
      output_config: { format: { type: "json_schema", schema: extractionJsonSchema } },
    });

    const usage = toUsage(response.usage);
    const raw = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    throwIfIncomplete(anthropicIncomplete(response.stop_reason), response.stop_reason ?? "unknown", raw, usage);
    return {
      result: parseExtractionOutput(raw, usage),
      usage,
      model: response.model,
      promptVersion: EXTRACT_MEAL_PROMPT_VERSION,
    };
  }

  async chat(input: ChatInput): Promise<ProviderTurn> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: EXTRACTION_MAX_OUTPUT_TOKENS,
      system: input.system,
      messages: input.messages.map(toAnthropicMessage),
      tools: input.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: { type: "object" as const, ...tool.parameters },
      })),
    });

    const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    const toolCalls = response.content.flatMap((block) =>
      block.type === "tool_use" ? [{ id: block.id, name: block.name, input: block.input }] : [],
    );
    return {
      text,
      toolCalls,
      stopReason: STOP_REASONS[response.stop_reason ?? ""] ?? "other",
      usage: toUsage(response.usage),
      model: response.model,
    };
  }
}

const STOP_REASONS: Record<string, ProviderTurn["stopReason"]> = {
  end_turn: "end",
  tool_use: "tool_calls",
  max_tokens: "max_tokens",
  refusal: "refusal",
};

export function anthropicIncomplete(stopReason: string | null): IncompleteStop | null {
  if (stopReason === "refusal") return "refusal";
  if (stopReason === "max_tokens") return "max_tokens";
  return null;
}

function toUsage(usage: Anthropic.Usage): TokenUsage {
  return {
    inputTokens:
      usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
    outputTokens: usage.output_tokens,
  };
}

function toAnthropicMessage(message: ProviderMessage): Anthropic.MessageParam {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.text };
    case "assistant": {
      const content: Anthropic.ContentBlockParam[] = [];
      if (message.text) content.push({ type: "text", text: message.text });
      for (const call of message.toolCalls) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
      }
      return { role: "assistant", content };
    }
    case "tool":
      return {
        role: "user",
        content: message.results.map((result) => ({
          type: "tool_result" as const,
          tool_use_id: result.callId,
          content: JSON.stringify(result.output),
          is_error: result.isError ?? false,
        })),
      };
  }
}
