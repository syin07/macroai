import type { ActivityLevel, Macros, Sex, SuggestGoalsRequest, SuggestGoalsResponse, WeightGoal } from "@/types/api";

// Suggested daily targets (PRD FR-11): Mifflin–St Jeor BMR × activity multiplier + goal adjustment,
// then protein by body weight, fat as a share of calories, and carbs as the remainder. Pure; the route
// in B12 wraps it. Outputs are whole numbers so they can be saved as-is through PUT /api/goals.

export const ACTIVITY_MULTIPLIERS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

export const GOAL_ADJUSTMENT_KCAL: Record<WeightGoal, number> = { lose: -500, maintain: 0, gain: 300 };

export const PROTEIN_G_PER_KG = 1.8;
export const FAT_SHARE_OF_CALORIES = 0.25;
// Never suggest an intake below this, whatever the inputs (e.g. a small, sedentary person aiming to lose).
export const MIN_SUGGESTED_CALORIES = 1200;

const KCAL_PER_G = { protein: 4, carbs: 4, fat: 9 } as const;

export function mifflinStJeorBmr(input: { weight_kg: number; height_cm: number; age: number; sex: Sex }): number {
  const base = 10 * input.weight_kg + 6.25 * input.height_cm - 5 * input.age;
  return input.sex === "male" ? base + 5 : base - 161;
}

export function totalDailyEnergy(bmr: number, activity: ActivityLevel): number {
  return bmr * ACTIVITY_MULTIPLIERS[activity];
}

// Whole kcal, floored at MIN_SUGGESTED_CALORIES.
export function targetCalories(tdee: number, goal: WeightGoal): number {
  return Math.max(MIN_SUGGESTED_CALORIES, Math.round(tdee + GOAL_ADJUSTMENT_KCAL[goal]));
}

// Whole grams. Carbs take whatever energy protein and fat leave (never below zero).
export function splitMacros(calories: number, weightKg: number): Macros {
  const protein_g = Math.round(PROTEIN_G_PER_KG * weightKg);
  const fat_g = Math.round((FAT_SHARE_OF_CALORIES * calories) / KCAL_PER_G.fat);
  const leftover = calories - protein_g * KCAL_PER_G.protein - fat_g * KCAL_PER_G.fat;
  const carbs_g = Math.max(0, Math.round(leftover / KCAL_PER_G.carbs));
  return { calories, protein_g, carbs_g, fat_g };
}

const ACTIVITY_LABEL: Record<ActivityLevel, string> = {
  sedentary: "sedentary",
  light: "lightly active",
  moderate: "moderately active",
  active: "active",
  very_active: "very active",
};

const kcal = (n: number) => `${Math.round(n).toLocaleString("en-US")} kcal`;

export function suggestGoals(input: SuggestGoalsRequest): SuggestGoalsResponse {
  const bmr = mifflinStJeorBmr(input);
  const tdee = totalDailyEnergy(bmr, input.activity);
  const calories = targetCalories(tdee, input.goal);
  const suggested = splitMacros(calories, input.weight_kg);

  const adjustment = GOAL_ADJUSTMENT_KCAL[input.goal];
  const goalText =
    adjustment === 0 ? "to maintain your weight" : `${adjustment < 0 ? "minus" : "plus"} ${kcal(Math.abs(adjustment))} to ${input.goal} weight`;
  const floored = calories === MIN_SUGGESTED_CALORIES && Math.round(tdee + adjustment) < MIN_SUGGESTED_CALORIES;

  const explanation = [
    `Your estimated maintenance is about ${kcal(tdee)} a day: a resting rate of ${kcal(bmr)} (Mifflin–St Jeor) × ${ACTIVITY_MULTIPLIERS[input.activity]} for ${ACTIVITY_LABEL[input.activity]}.`,
    `Target: ${kcal(calories)}, ${goalText}.${floored ? ` We don't suggest going below ${kcal(MIN_SUGGESTED_CALORIES)}.` : ""}`,
    `Protein is ${PROTEIN_G_PER_KG} g per kg of body weight, fat is ${FAT_SHARE_OF_CALORIES * 100}% of calories, and carbs fill the rest.`,
    "This is an estimate, not medical advice. Adjust it based on how your weight changes over a few weeks.",
  ].join(" ");

  return { suggested, explanation };
}
