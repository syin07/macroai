import { describe, expect, it } from "vitest";
import type { SuggestGoalsRequest } from "@/types/api";
import { putGoalsRequestSchema, suggestGoalsResponseSchema } from "@/lib/validation";
import {
  ACTIVITY_MULTIPLIERS,
  GOAL_ADJUSTMENT_KCAL,
  MIN_SUGGESTED_CALORIES,
  mifflinStJeorBmr,
  splitMacros,
  suggestGoals,
  targetCalories,
  totalDailyEnergy,
} from "./goals";

// Hand calculations. Mifflin–St Jeor: 10·kg + 6.25·cm − 5·age, then +5 (male) or −161 (female).

describe("mifflinStJeorBmr", () => {
  it("male, 30 y, 180 cm, 80 kg: 800 + 1125 − 150 + 5 = 1780", () => {
    expect(mifflinStJeorBmr({ weight_kg: 80, height_cm: 180, age: 30, sex: "male" })).toBe(1780);
  });

  it("female, 25 y, 165 cm, 60 kg: 600 + 1031.25 − 125 − 161 = 1345.25", () => {
    expect(mifflinStJeorBmr({ weight_kg: 60, height_cm: 165, age: 25, sex: "female" })).toBe(1345.25);
  });

  it("differs by exactly 166 kcal between sexes for the same body", () => {
    const body = { weight_kg: 70, height_cm: 170, age: 40 };
    expect(mifflinStJeorBmr({ ...body, sex: "male" }) - mifflinStJeorBmr({ ...body, sex: "female" })).toBe(166);
  });
});

describe("activity and goal adjustment", () => {
  it("uses the PRD multipliers", () => {
    expect(ACTIVITY_MULTIPLIERS).toEqual({ sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 });
    expect(totalDailyEnergy(1780, "moderate")).toBeCloseTo(2759, 9);
    expect(totalDailyEnergy(1000, "very_active")).toBeCloseTo(1900, 9);
  });

  it("uses −500 / 0 / +300 kcal and rounds to whole kcal", () => {
    expect(GOAL_ADJUSTMENT_KCAL).toEqual({ lose: -500, maintain: 0, gain: 300 });
    expect(targetCalories(2759, "maintain")).toBe(2759);
    expect(targetCalories(2759, "lose")).toBe(2259);
    expect(targetCalories(2759.4, "gain")).toBe(3059);
  });

  it(`never goes below ${MIN_SUGGESTED_CALORIES} kcal`, () => {
    expect(targetCalories(1500, "lose")).toBe(MIN_SUGGESTED_CALORIES);
  });
});

describe("splitMacros", () => {
  it("2759 kcal, 80 kg: protein 144 g, fat 77 g, carbs 373 g", () => {
    // protein 1.8 × 80 = 144 g; fat 0.25 × 2759 / 9 = 76.6 → 77 g;
    // carbs (2759 − 144·4 − 77·9) / 4 = (2759 − 576 − 693) / 4 = 372.5 → 373 g.
    expect(splitMacros(2759, 80)).toEqual({ calories: 2759, protein_g: 144, fat_g: 77, carbs_g: 373 });
  });

  it("macro energy stays within a few kcal of the target", () => {
    for (const [kcal, kg] of [[1800, 55], [2400, 72.5], [3100, 95], [2000, 63.3]] as const) {
      const m = splitMacros(kcal, kg);
      expect(Math.abs(m.protein_g * 4 + m.carbs_g * 4 + m.fat_g * 9 - kcal)).toBeLessThanOrEqual(4);
    }
  });

  it("never suggests negative carbs", () => {
    // 1.8 × 200 = 360 g protein = 1440 kcal, more than the whole 1200 kcal budget.
    expect(splitMacros(1200, 200).carbs_g).toBe(0);
  });
});

describe("suggestGoals", () => {
  const base: SuggestGoalsRequest = { age: 30, height_cm: 180, weight_kg: 80, sex: "male", activity: "moderate", goal: "maintain" };

  it.each<[string, SuggestGoalsRequest, { calories: number; protein_g: number; carbs_g: number; fat_g: number }]>([
    // BMR 1780 × 1.55 = 2759; see splitMacros above.
    ["male, moderate, maintain", base, { calories: 2759, protein_g: 144, carbs_g: 373, fat_g: 77 }],
    // BMR 1345.25 × 1.375 = 1849.72; − 500 = 1349.72 → 1350 kcal. Protein 108 g; fat 337.5 / 9 = 37.5 → 38 g;
    // carbs (1350 − 432 − 342) / 4 = 144 g.
    [
      "female, light, lose",
      { age: 25, height_cm: 165, weight_kg: 60, sex: "female", activity: "light", goal: "lose" },
      { calories: 1350, protein_g: 108, carbs_g: 144, fat_g: 38 },
    ],
    // BMR 700 + 1093.75 − 100 + 5 = 1698.75 × 1.9 = 3227.63; + 300 = 3527.63 → 3528 kcal. Protein 126 g;
    // fat 882 / 9 = 98 g; carbs (3528 − 504 − 882) / 4 = 535.5 → 536 g.
    [
      "male, very active, gain",
      { age: 20, height_cm: 175, weight_kg: 70, sex: "male", activity: "very_active", goal: "gain" },
      { calories: 3528, protein_g: 126, carbs_g: 536, fat_g: 98 },
    ],
    // BMR 450 + 937.5 − 300 − 161 = 926.5 × 1.2 = 1111.8; − 500 = 611.8 → floored to 1200 kcal. Protein 81 g;
    // fat 300 / 9 = 33.3 → 33 g; carbs (1200 − 324 − 297) / 4 = 144.75 → 145 g.
    [
      "female, sedentary, lose (hits the floor)",
      { age: 60, height_cm: 150, weight_kg: 45, sex: "female", activity: "sedentary", goal: "lose" },
      { calories: 1200, protein_g: 81, carbs_g: 145, fat_g: 33 },
    ],
  ])("%s", (_label, request, expected) => {
    expect(suggestGoals(request).suggested).toEqual(expected);
  });

  it("returns a contract-valid response whose targets can be saved as-is", () => {
    const response = suggestGoals(base);
    expect(suggestGoalsResponseSchema.safeParse(response).success).toBe(true);
    expect(putGoalsRequestSchema.safeParse(response.suggested).success).toBe(true);
  });

  it("explains the numbers and that it isn't medical advice", () => {
    const { explanation } = suggestGoals(base);
    expect(explanation).toContain("2,759 kcal");
    expect(explanation).toContain("1,780 kcal");
    expect(explanation).toContain("× 1.55");
    expect(explanation).toContain("not medical advice");
    expect(explanation).not.toContain("going below");
  });

  it("mentions the floor only when it applied", () => {
    const floored = suggestGoals({ age: 60, height_cm: 150, weight_kg: 45, sex: "female", activity: "sedentary", goal: "lose" });
    expect(floored.explanation).toContain("We don't suggest going below 1,200 kcal");
    expect(suggestGoals({ ...base, goal: "lose" }).explanation).toContain("minus 500 kcal to lose weight");
    expect(suggestGoals({ ...base, goal: "gain" }).explanation).toContain("plus 300 kcal to gain weight");
  });

  it("ignores target weight in the math (protein uses current body weight)", () => {
    expect(suggestGoals({ ...base, target_weight_kg: 70 }).suggested).toEqual(suggestGoals(base).suggested);
  });
});
