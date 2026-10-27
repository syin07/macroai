import OpenAI from "openai";
import { EXTRACTION_MAX_OUTPUT_TOKENS, PROVIDER_TIMEOUT_MS } from "./shared";
import { EXTRACTION_SCHEMA_NAME, ExtractionOutputError, extractionJsonSchema, parseExtractionOutput, type TokenUsage } from "../extraction";
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

// Current mini tier with vision and structured outputs. Override with OPENAI_MODEL to try others.
export const OPENAI_DEFAULT_MODEL = "gpt-5.4-mini";

export interface OpenAIProviderOptions {
  apiKey?: string; // defaults to OPENAI_API_KEY
  model?: string;
  // Low keeps latency and cost down for extraction. Set to null for models without reasoning.
  reasoningEffort?: OpenAI.ReasoningEffort | null;
}

// OpenAI via Chat Completions with response_format json_schema (strict). Chat Completions is
// stateless and doesn't store requests by default, unlike the Responses API (store defaults to
// true), which matters because meal photos must not be retained (PRD FR-15).
export class OpenAIProvider implements AIProvider {
  readonly name = "openai" as const;
  readonly model: string;
  private readonly client: OpenAI;
  private readonly reasoningEffort: OpenAI.ReasoningEffort | null;

  constructor(options: OpenAIProviderOptions = {}) {
    this.model = options.model ?? OPENAI_DEFAULT_MODEL;
    this.reasoningEffort = options.reasoningEffort === undefined ? "low" : options.reasoningEffort;
    this.client = new OpenAI({ apiKey: options.apiKey, timeout: PROVIDER_TIMEOUT_MS });
  }

  async extractMeal(input: ExtractMealInput): Promise<ExtractMealOutput> {
    const content: OpenAI.Chat.ChatCompletionContentPart[] = [];
    if (input.image) {
      content.push({
        type: "image_url",
        image_url: { url: `data:${input.image.mediaType};base64,${imageToBase64(input.image)}` },
      });
    }
    content.push({ type: "text", text: buildExtractMealUserText(input) });

    const completion = await this.client.chat.completions.create({
      model: this.model,
      max_completion_tokens: EXTRACTION_MAX_OUTPUT_TOKENS,
      ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
      messages: [
        { role: "developer", content: EXTRACT_MEAL_SYSTEM_PROMPT },
        { role: "user", content },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: EXTRACTION_SCHEMA_NAME, schema: extractionJsonSchema, strict: true },
      },
    });

    const usage = toUsage(completion.usage);
    const message = completion.choices[0]?.message;
    if (message?.refusal) throw new ExtractionOutputError(`Model refused: ${message.refusal}`, "", usage);
    return {
      result: parseExtractionOutput(message?.content ?? "", usage),
      usage,
      model: completion.model,
      promptVersion: EXTRACT_MEAL_PROMPT_VERSION,
    };
  }

  async chat(input: ChatInput): Promise<ProviderTurn> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      max_completion_tokens: EXTRACTION_MAX_OUTPUT_TOKENS,
      ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
      messages: [{ role: "developer", content: input.system }, ...input.messages.flatMap(toOpenAIMessages)],
      tools: input.tools.map((tool) => ({
        type: "function" as const,
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
    });

    const choice = completion.choices[0];
    const message = choice?.message;
    const toolCalls = (message?.tool_calls ?? []).flatMap((call) =>
      call.type === "function"
        ? [{ id: call.id, name: call.function.name, input: parseToolArguments(call.function.arguments) }]
        : [],
    );
    return {
      text: message?.content ?? "",
      toolCalls,
      stopReason: message?.refusal ? "refusal" : (FINISH_REASONS[choice?.finish_reason ?? ""] ?? "other"),
      usage: toUsage(completion.usage),
      model: completion.model,
    };
  }
}

const FINISH_REASONS: Record<string, ProviderTurn["stopReason"]> = {
  stop: "end",
  tool_calls: "tool_calls",
  length: "max_tokens",
  content_filter: "refusal",
};

function toUsage(usage: OpenAI.CompletionUsage | undefined): TokenUsage {
  // completion_tokens already includes reasoning tokens.
  return { inputTokens: usage?.prompt_tokens ?? 0, outputTokens: usage?.completion_tokens ?? 0 };
}

// Arguments arrive as a JSON string; malformed JSON is passed on as-is so the tool's Zod check rejects it.
function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function toOpenAIMessages(message: ProviderMessage): OpenAI.Chat.ChatCompletionMessageParam[] {
  switch (message.role) {
    case "user":
      return [{ role: "user", content: message.text }];
    case "assistant":
      return [
        {
          role: "assistant",
          content: message.text || null,
          ...(message.toolCalls.length > 0
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function" as const,
                  function: { name: call.name, arguments: JSON.stringify(call.input) },
                })),
              }
            : {}),
        },
      ];
    case "tool":
      return message.results.map((result) => ({
        role: "tool" as const,
        tool_call_id: result.callId,
        content: JSON.stringify(result.isError ? { error: result.output } : result.output),
      }));
  }
}
