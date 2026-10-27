import { describe, expect, it } from "vitest";
import {
  chatFormSchema,
  dailySummarySchema,
  deleteAccountRequestSchema,
  exportQuerySchema,
  imageFileSchema,
  isImageTooLarge,
  mealCardSchema,
  mealsQuerySchema,
  messagesQuerySchema,
  patchPreferencesRequestSchema,
  putGoalsRequestSchema,
  saveMealsRequestSchema,
  suggestGoalsRequestSchema,
  timezone,
  updateMealRequestSchema,
  zodErrorToFields,
} from "./index";

const ID = "3f1c2b9e-8a4d-4c6e-9f2a-1b3c4d5e6f70";

const egg = {
  food_name: "Egg, whole, cooked",
  quantity: 2,
  unit: "large",
  grams: 100,
  basis_per_100g: { calories: 155, protein_g: 12.6, carbs_g: 1.1, fat_g: 10.6 },
  macros: { calories: 155, protein_g: 12.6, carbs_g: 1.1, fat_g: 10.6 },
  nutrition_source: "usda" as const,
  source_reference: "173424",
  inferred: false,
  confidence: null,
  edited_by_user: false,
  assumptions: null,
};

const meal = {
  proposal_id: ID,
  name: "Breakfast",
  consumed_at: "2026-10-26T08:15:00-07:00",
  source_type: "text" as const,
  items: [egg],
};

describe("timezone", () => {
  it("accepts IANA zones and UTC", () => {
    expect(timezone.safeParse("America/Los_Angeles").success).toBe(true);
    expect(timezone.safeParse("UTC").success).toBe(true);
  });

  it("rejects unknown zones", () => {
    expect(timezone.safeParse("Mars/Olympus_Mons").success).toBe(false);
    expect(timezone.safeParse("").success).toBe(false);
  });
});

describe("saveMealsRequestSchema", () => {
  it("accepts a valid proposal save", () => {
    expect(saveMealsRequestSchema.safeParse({ meals: [meal] }).success).toBe(true);
  });

  it("accepts a manual entry with no proposal_id and no basis", () => {
    const manual = {
      ...meal,
      proposal_id: null,
      source_type: "manual" as const,
      items: [{ ...egg, grams: null, basis_per_100g: null, nutrition_source: "manual" as const, source_reference: null }],
    };
    expect(saveMealsRequestSchema.safeParse({ meals: [manual] }).success).toBe(true);
  });

  it("rejects negative macros", () => {
    const bad = { ...meal, items: [{ ...egg, macros: { ...egg.macros, protein_g: -1 } }] };
    expect(saveMealsRequestSchema.safeParse({ meals: [bad] }).success).toBe(false);
  });

  it("rejects a database basis without grams", () => {
    const bad = { ...meal, items: [{ ...egg, grams: null }] };
    const result = saveMealsRequestSchema.safeParse({ meals: [bad] });
    expect(result.success).toBe(false);
    if (!result.success) expect(zodErrorToFields(result.error)).toHaveProperty(["meals.0.items.0.grams"]);
  });

  it("rejects timestamps without an offset", () => {
    const bad = { ...meal, consumed_at: "2026-10-26T08:15:00" };
    expect(saveMealsRequestSchema.safeParse({ meals: [bad] }).success).toBe(false);
  });

  it("rejects an empty meals array and meals with no items", () => {
    expect(saveMealsRequestSchema.safeParse({ meals: [] }).success).toBe(false);
    expect(saveMealsRequestSchema.safeParse({ meals: [{ ...meal, items: [] }] }).success).toBe(false);
  });

  it("strips a client-sent item id so it can't choose the database row ID", () => {
    const parsed = saveMealsRequestSchema.parse({ meals: [{ ...meal, items: [{ ...egg, id: ID }] }] });
    expect(parsed.meals[0]!.items[0]).not.toHaveProperty("id");
  });
});

describe("updateMealRequestSchema", () => {
  it("requires version and at least one change", () => {
    expect(updateMealRequestSchema.safeParse({ version: 1, name: "Lunch" }).success).toBe(true);
    expect(updateMealRequestSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(updateMealRequestSchema.safeParse({ name: "Lunch" }).success).toBe(false);
  });

  it("accepts items with existing and new ids", () => {
    const items = [{ ...egg, id: ID }, { ...egg, id: null }];
    expect(updateMealRequestSchema.safeParse({ version: 3, items }).success).toBe(true);
  });
});

describe("query schemas", () => {
  it("defaults and coerces limit", () => {
    expect(messagesQuerySchema.parse({}).limit).toBe(30);
    expect(mealsQuerySchema.parse({ limit: "10" }).limit).toBe(10);
    expect(mealsQuerySchema.safeParse({ limit: "1000" }).success).toBe(false);
  });

  it("rejects from after to", () => {
    expect(mealsQuerySchema.safeParse({ from: "2026-10-27", to: "2026-10-26" }).success).toBe(false);
    expect(mealsQuerySchema.safeParse({ from: "2026-10-26", to: "2026-10-26" }).success).toBe(true);
  });

  it("only allows JSON for account export", () => {
    expect(exportQuerySchema.safeParse({ format: "csv", scope: "account" }).success).toBe(false);
    expect(exportQuerySchema.parse({ format: "csv" }).scope).toBe("nutrition");
  });
});

describe("chatFormSchema", () => {
  it("treats blank text as missing", () => {
    const parsed = chatFormSchema.parse({ client_message_id: ID, text: "   ", timezone: "UTC" });
    expect(parsed.text).toBeUndefined();
  });

  it("rejects text over 2,000 characters", () => {
    const result = chatFormSchema.safeParse({ client_message_id: ID, text: "a".repeat(2001), timezone: "UTC" });
    expect(result.success).toBe(false);
  });
});

describe("imageFileSchema", () => {
  it("accepts a small JPEG", () => {
    expect(imageFileSchema.safeParse(new Blob([new Uint8Array(10)], { type: "image/jpeg" })).success).toBe(true);
  });

  it("rejects other types and oversize files", () => {
    expect(imageFileSchema.safeParse(new Blob([new Uint8Array(10)], { type: "image/gif" })).success).toBe(false);
    const big = new Blob([new Uint8Array(1.5 * 1024 * 1024 + 1)], { type: "image/jpeg" });
    expect(imageFileSchema.safeParse(big).success).toBe(false);
    expect(isImageTooLarge(big)).toBe(true);
  });
});

describe("goals and preferences", () => {
  it("validates goal targets", () => {
    expect(putGoalsRequestSchema.safeParse({ calories: 2200, protein_g: 160, carbs_g: 220, fat_g: 70 }).success).toBe(true);
    expect(putGoalsRequestSchema.safeParse({ calories: 100, protein_g: 160, carbs_g: 220, fat_g: 70 }).success).toBe(false);
  });

  it("validates suggest input", () => {
    const body = { age: 30, height_cm: 175, weight_kg: 75, sex: "male", activity: "moderate", goal: "maintain" };
    expect(suggestGoalsRequestSchema.safeParse(body).success).toBe(true);
    expect(suggestGoalsRequestSchema.safeParse({ ...body, activity: "extreme" }).success).toBe(false);
  });

  it("rejects empty and unknown preference patches", () => {
    expect(patchPreferencesRequestSchema.safeParse({ theme: "dark" }).success).toBe(true);
    expect(patchPreferencesRequestSchema.safeParse({}).success).toBe(false);
    expect(patchPreferencesRequestSchema.safeParse({ them: "dark" }).success).toBe(false);
  });

  it("allows negative remaining in a daily summary", () => {
    const zero = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
    const summary = {
      date: "2026-10-26",
      timezone: "UTC",
      consumed: zero,
      targets: zero,
      remaining: { ...zero, calories: -120 },
      meals: [],
    };
    expect(dailySummarySchema.safeParse(summary).success).toBe(true);
  });
});

describe("misc", () => {
  it("discriminates meal cards", () => {
    expect(mealCardSchema.safeParse({ kind: "meal", meal_id: ID, meal: null }).success).toBe(true);
    expect(mealCardSchema.safeParse({ kind: "meal", meal_id: ID }).success).toBe(false);
  });

  it("requires the literal DELETE to delete an account", () => {
    expect(deleteAccountRequestSchema.safeParse({ confirm: "DELETE" }).success).toBe(true);
    expect(deleteAccountRequestSchema.safeParse({ confirm: "delete" }).success).toBe(false);
  });
});
