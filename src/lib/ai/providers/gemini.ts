import { randomUUID } from "node:crypto";
import { GoogleGenAI, ThinkingLevel, type Content, type GenerateContentResponse, type Part } from "@google/genai";
import { EXTRACTION_MAX_OUTPUT_TOKENS, PROVIDER_TIMEOUT_MS } from "./shared";
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

export const GEMINI_DEFAULT_MODEL = "gemini-3.1-flash-lite";

export interface GeminiProviderOptions {
  apiKey?: string; // defaults to GEMINI_API_KEY
  model?: string;
  // Low keeps latency and cost down for extraction; try MEDIUM if mixed dishes come out poorly.
  thinkingLevel?: ThinkingLevel;
}

// Gemini via the Gemini Developer API. Extraction uses JSON mode with responseJsonSchema.
// Note: only paid-tier API traffic is excluded from training; check the data policy before launch.
export class GeminiProvider implements AIProvider {
  readonly name = "gemini" as const;
  readonly model: string;
  private readonly client: GoogleGenAI;
  private readonly thinkingLevel: ThinkingLevel;

  constructor(options: GeminiProviderOptions = {}) {
    this.model = options.model ?? GEMINI_DEFAULT_MODEL;
    this.thinkingLevel = options.thinkingLevel ?? ThinkingLevel.LOW;
    this.client = new GoogleGenAI({
      apiKey: options.apiKey ?? process.env.GEMINI_API_KEY,
      httpOptions: { timeout: PROVIDER_TIMEOUT_MS },
    });
  }

  async extractMeal(input: ExtractMealInput): Promise<ExtractMealOutput> {
    const parts: Part[] = [];
    if (input.image) {
      parts.push({ inlineData: { mimeType: input.image.mediaType, data: imageToBase64(input.image) } });
    }
    parts.push({ text: buildExtractMealUserText(input) });

    const response = await this.client.models.generateContent({
      model: this.model,
      contents: [{ role: "user", parts }],
      config: {
        systemInstruction: EXTRACT_MEAL_SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseJsonSchema: extractionJsonSchema,
        maxOutputTokens: EXTRACTION_MAX_OUTPUT_TOKENS,
        thinkingConfig: { thinkingLevel: this.thinkingLevel },
      },
    });

    const usage = toUsage(response);
    return {
      result: parseExtractionOutput(response.text ?? "", usage),
      usage,
      model: response.modelVersion ?? this.model,
      promptVersion: EXTRACT_MEAL_PROMPT_VERSION,
    };
  }

  async chat(input: ChatInput): Promise<ProviderTurn> {
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: input.messages.map(toGeminiContent),
      config: {
        systemInstruction: input.system,
        maxOutputTokens: EXTRACTION_MAX_OUTPUT_TOKENS,
        thinkingConfig: { thinkingLevel: this.thinkingLevel },
        tools: [
          {
            functionDeclarations: input.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parametersJsonSchema: tool.parameters,
            })),
          },
        ],
      },
    });

    // Gemini 3 requires each functionCall part's thoughtSignature to be sent back with it.
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    const toolCalls = parts.flatMap((part) =>
      part.functionCall?.name
        ? [
            {
              id: part.functionCall.id ?? randomUUID(),
              name: part.functionCall.name,
              input: part.functionCall.args ?? {},
              providerData: part.thoughtSignature,
            },
          ]
        : [],
    );
    const finishReason = response.candidates?.[0]?.finishReason;
    return {
      text: response.text ?? "",
      toolCalls,
      stopReason: toolCalls.length > 0 ? "tool_calls" : (FINISH_REASONS[finishReason ?? ""] ?? "other"),
      usage: toUsage(response),
      model: response.modelVersion ?? this.model,
    };
  }
}

const FINISH_REASONS: Record<string, ProviderTurn["stopReason"]> = {
  STOP: "end",
  MAX_TOKENS: "max_tokens",
  SAFETY: "refusal",
};

function toUsage(response: GenerateContentResponse): TokenUsage {
  const usage = response.usageMetadata;
  return {
    inputTokens: usage?.promptTokenCount ?? 0,
    // Thinking tokens are billed as output.
    outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
  };
}

function toGeminiContent(message: ProviderMessage): Content {
  switch (message.role) {
    case "user":
      return { role: "user", parts: [{ text: message.text }] };
    case "assistant": {
      const parts: Part[] = [];
      if (message.text) parts.push({ text: message.text });
      for (const call of message.toolCalls) {
        parts.push({
          functionCall: { id: call.id, name: call.name, args: call.input as Record<string, unknown> },
          thoughtSignature: call.providerData,
        });
      }
      return { role: "model", parts };
    }
    case "tool":
      return {
        role: "user",
        parts: message.results.map((result) => ({
          functionResponse: {
            id: result.callId,
            name: result.name,
            response: result.isError ? { error: result.output } : { output: result.output },
          },
        })),
      };
  }
}
