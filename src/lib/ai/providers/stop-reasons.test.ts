import { describe, expect, it } from "vitest";
import { ExtractionOutputError, parseExtractionOutput } from "../extraction";
import { anthropicIncomplete } from "./anthropic";
import { geminiIncomplete } from "./gemini";
import { openaiIncomplete } from "./openai";
import { throwIfIncomplete } from "./shared";

const usage = { inputTokens: 10, outputTokens: 5 };

describe("stop reasons", () => {
  it("maps Anthropic stop reasons", () => {
    expect(anthropicIncomplete("end_turn")).toBeNull();
    expect(anthropicIncomplete("refusal")).toBe("refusal");
    expect(anthropicIncomplete("max_tokens")).toBe("max_tokens");
  });

  it("maps Gemini finish and block reasons", () => {
    expect(geminiIncomplete("STOP", undefined)).toBeNull();
    expect(geminiIncomplete("MAX_TOKENS", undefined)).toBe("max_tokens");
    expect(geminiIncomplete("SAFETY", undefined)).toBe("safety");
    expect(geminiIncomplete("PROHIBITED_CONTENT", undefined)).toBe("safety");
    expect(geminiIncomplete(undefined, "SAFETY")).toBe("safety");
  });

  it("maps OpenAI finish reasons and refusals", () => {
    expect(openaiIncomplete("stop", null)).toBeNull();
    expect(openaiIncomplete("stop", "I can't help with that")).toBe("refusal");
    expect(openaiIncomplete("length", null)).toBe("max_tokens");
    expect(openaiIncomplete("content_filter", null)).toBe("safety");
  });

  it("reports a truncated response as max_tokens, not invalid JSON", () => {
    const truncated = '{"intent":"log_meal","meals":[{"name":"Eg';
    const error = (() => {
      try {
        throwIfIncomplete("max_tokens", "length", truncated, usage);
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(ExtractionOutputError);
    expect(error).toMatchObject({ failure: "max_tokens", raw: truncated, usage });
    expect(() => throwIfIncomplete(null, "stop", truncated, usage)).not.toThrow();
  });

  it("still classifies parse failures", () => {
    expect(() => parseExtractionOutput("not json", usage)).toThrow(expect.objectContaining({ failure: "invalid_json" }));
    expect(() => parseExtractionOutput("{}", usage)).toThrow(expect.objectContaining({ failure: "schema_mismatch" }));
  });
});
