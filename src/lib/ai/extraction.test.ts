import { describe, expect, it } from "vitest";
import {
  ExtractionOutputError,
  extractionJsonSchema,
  extractionResultSchema,
  parseExtractionOutput,
  type ExtractionResult,
} from "./extraction";

const usage = { inputTokens: 100, outputTokens: 50 };

function validResult(): ExtractionResult {
  return {
    intent: "log_meal",
    meals: [
      {
        name: "Eggs and Toast",
        consumed_at: "2026-10-26T08:00:00-07:00",
        time_phrase: "this morning",
        foods: [
          {
            name: "Fried egg",
            brand: null,
            quantity: 2,
            unit: "egg",
            grams: 92,
            preparation: "fried",
            estimated_quantity: false,
            inferred: false,
            confidence: "high",
            search_query: "egg, whole, fried",
            estimated_macros: { calories: 180, protein_g: 12.5, carbs_g: 0.8, fat_g: 14 },
            estimate_range: { calories_low: 160, calories_high: 200, protein_g_low: 11, protein_g_high: 14 },
            notes: null,
          },
        ],
        needs_clarification: false,
        clarification_question: null,
      },
    ],
    explanation: null,
  };
}

describe("extractionResultSchema", () => {
  it("accepts a well-formed result", () => {
    expect(extractionResultSchema.parse(validResult())).toEqual(validResult());
  });

  it("accepts a no-meal answer for hypotheticals", () => {
    const result = { intent: "question", meals: [], explanation: "Asking, not logging." };
    expect(extractionResultSchema.safeParse(result).success).toBe(true);
  });

  it("requires nullable fields to be present", () => {
    const result = validResult() as Record<string, unknown>;
    delete result.explanation;
    expect(extractionResultSchema.safeParse(result).success).toBe(false);
  });

  it("rejects consumed_at without a UTC offset", () => {
    const result = validResult();
    result.meals[0]!.consumed_at = "2026-10-26T08:00:00";
    expect(extractionResultSchema.safeParse(result).success).toBe(false);
  });

  it.each([
    ["negative grams", (r: ExtractionResult) => (r.meals[0]!.foods[0]!.grams = -5)],
    ["zero quantity", (r: ExtractionResult) => (r.meals[0]!.foods[0]!.quantity = 0)],
    ["absurd calories", (r: ExtractionResult) => (r.meals[0]!.foods[0]!.estimated_macros.calories = 1e9)],
    ["empty food list", (r: ExtractionResult) => (r.meals[0]!.foods = [])],
    ["unknown confidence", (r: ExtractionResult) => ((r.meals[0]!.foods[0]! as { confidence: string }).confidence = "certain")],
  ])("rejects %s", (_, mutate) => {
    const result = validResult();
    mutate(result);
    expect(extractionResultSchema.safeParse(result).success).toBe(false);
  });
});

describe("parseExtractionOutput", () => {
  it("parses valid JSON text", () => {
    expect(parseExtractionOutput(JSON.stringify(validResult()), usage)).toEqual(validResult());
  });

  it("throws ExtractionOutputError with the raw text and usage for non-JSON", () => {
    const error = (() => {
      try {
        parseExtractionOutput("Sure! Here is the JSON:", usage);
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(ExtractionOutputError);
    expect((error as ExtractionOutputError).raw).toBe("Sure! Here is the JSON:");
    expect((error as ExtractionOutputError).usage).toEqual(usage);
  });

  it("reports schema issues", () => {
    const bad = { ...validResult(), intent: "log_food" };
    expect(() => parseExtractionOutput(JSON.stringify(bad), usage)).toThrow(ExtractionOutputError);
    try {
      parseExtractionOutput(JSON.stringify(bad), usage);
    } catch (error) {
      expect((error as ExtractionOutputError).issues[0]?.path).toEqual(["intent"]);
    }
  });
});

describe("extractionJsonSchema", () => {
  type Node = Record<string, unknown>;

  function walk(node: unknown, visit: (node: Node) => void) {
    if (Array.isArray(node)) return node.forEach((child) => walk(child, visit));
    if (!node || typeof node !== "object") return;
    visit(node as Node);
    Object.values(node).forEach((child) => walk(child, visit));
  }

  it("closes every object and requires every property (strict structured-output rules)", () => {
    let objects = 0;
    walk(extractionJsonSchema, (node) => {
      if (node.type !== "object" || !node.properties) return;
      objects++;
      expect(node.additionalProperties).toBe(false);
      expect(node.required).toEqual(Object.keys(node.properties as Node));
    });
    expect(objects).toBe(5); // result, meal, food, estimated_macros, estimate_range
  });

  it("has no keywords that some providers reject", () => {
    const banned = ["$schema", "minimum", "maximum", "exclusiveMinimum", "minLength", "maxLength", "maxItems", "pattern", "format"];
    walk(extractionJsonSchema, (node) => {
      for (const key of banned) expect(node).not.toHaveProperty(key);
    });
  });

  it("keeps descriptions and enums for the model", () => {
    const intent = (extractionJsonSchema.properties as Record<string, Node>).intent!;
    expect(intent.enum).toEqual(["log_meal", "correction", "question", "other"]);
    expect(typeof intent.description).toBe("string");
  });
});
