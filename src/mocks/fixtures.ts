import type {
  ApiError,
  ChatMessage,
  ErrorCode,
  Macros,
  Meal,
  MealItem,
  MealProposal,
} from "@/types/api";

export const errorStatuses: Record<ErrorCode, number> = {
  unauthenticated: 401,
  not_approved: 403,
  validation_error: 400,
  payload_too_large: 413,
  not_found: 404,
  version_conflict: 409,
  ai_cap_reached: 429,
  ai_unavailable: 503,
  internal: 500,
};
export const errorFixtures: Record<ErrorCode, ApiError> = {
  unauthenticated: {
    error: {
      code: "unauthenticated",
      message: "Please sign in.",
      retryable: false,
    },
  },
  not_approved: {
    error: {
      code: "not_approved",
      message: "This account is not approved.",
      retryable: false,
    },
  },
  validation_error: {
    error: {
      code: "validation_error",
      message: "Please check the highlighted fields.",
      retryable: false,
      fields: { text: "Enter a meal description." },
    },
  },
  payload_too_large: {
    error: {
      code: "payload_too_large",
      message: "Choose an image under 1.5 MB.",
      retryable: false,
    },
  },
  not_found: {
    error: {
      code: "not_found",
      message: "That record is no longer available.",
      retryable: false,
    },
  },
  version_conflict: {
    error: {
      code: "version_conflict",
      message: "This meal changed. Review it before saving again.",
      retryable: false,
    },
  },
  ai_cap_reached: {
    error: {
      code: "ai_cap_reached",
      message: "Today's AI limit is reached. You can log manually.",
      retryable: false,
    },
  },
  ai_unavailable: {
    error: {
      code: "ai_unavailable",
      message: "The assistant is unavailable. Please retry.",
      retryable: true,
    },
  },
  internal: {
    error: {
      code: "internal",
      message: "Something went wrong. Please try again.",
      retryable: true,
    },
  },
};

const macros = (
  calories: number,
  protein_g: number,
  carbs_g: number,
  fat_g: number,
): Macros => ({ calories, protein_g, carbs_g, fat_g });
export const zeroMacros = (): Macros => macros(0, 0, 0, 0);

// Mock arithmetic only. Real meals are always recalculated by Sandy's backend.
export function sumMockMacros(values: Macros[]): Macros {
  return values.reduce(
    (sum, value) => ({
      calories: sum.calories + value.calories,
      protein_g: sum.protein_g + value.protein_g,
      carbs_g: sum.carbs_g + value.carbs_g,
      fat_g: sum.fat_g + value.fat_g,
    }),
    zeroMacros(),
  );
}

export function createFixtures(now = new Date()) {
  const item: MealItem = {
    id: null,
    food_name: "Eggs and toast",
    quantity: 1,
    unit: "serving",
    grams: 160,
    basis_per_100g: macros(200, 12.5, 18.75, 8.75),
    macros: macros(320, 20, 30, 14),
    nutrition_source: "usda",
    source_reference: "https://fdc.nal.usda.gov/",
    inferred: false,
    confidence: "medium",
    edited_by_user: false,
    assumptions: "Two eggs and one slice of toast.",
  };
  const single: MealProposal = {
    proposal_id: crypto.randomUUID(),
    name: "Eggs and toast",
    consumed_at: now.toISOString(),
    items: [item],
    totals: item.macros,
    needs_clarification: false,
    clarification_question: null,
  };
  const chicken = {
    ...structuredClone(item),
    food_name: "Chicken and rice",
    grams: 400,
    basis_per_100g: macros(155, 12, 16.25, 4.5),
    macros: macros(620, 48, 65, 18),
    assumptions: "One chicken and rice bowl.",
  };
  const pizza = {
    ...structuredClone(item),
    food_name: "Pizza",
    grams: 200,
    basis_per_100g: macros(280, 12, 30, 12.5),
    macros: macros(560, 24, 60, 25),
    assumptions: "Two slices of pizza.",
  };
  const three = [
    single,
    {
      ...structuredClone(single),
      proposal_id: crypto.randomUUID(),
      name: "Chicken and rice",
      items: [chicken],
      totals: chicken.macros,
    },
    {
      ...structuredClone(single),
      proposal_id: crypto.randomUUID(),
      name: "Pizza",
      items: [pizza],
      totals: pizza.macros,
    },
  ];
  const oil: MealItem = {
    ...structuredClone(item),
    food_name: "Cooking oil",
    quantity: 1,
    unit: "tsp",
    grams: 5,
    basis_per_100g: macros(900, 0, 0, 100),
    macros: macros(45, 0, 0, 5),
    inferred: true,
    confidence: "low",
    assumptions: "Assumed one teaspoon of oil; adjust if needed.",
  };
  const photo: MealProposal = {
    ...structuredClone(single),
    proposal_id: crypto.randomUUID(),
    name: "Photo meal",
    items: [item, oil],
    totals: sumMockMacros([item.macros, oil.macros]),
  };
  const clarification: MealProposal = {
    ...structuredClone(three[1]),
    proposal_id: crypto.randomUUID(),
    name: "Chicken bowl",
    needs_clarification: true,
    clarification_question: "Was that one serving or two?",
  };
  const autoSaved: Meal = {
    id: crypto.randomUUID(),
    name: single.name,
    consumed_at: single.consumed_at,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    source_type: "text",
    items: [{ ...structuredClone(item), id: crypto.randomUUID() }],
    totals: single.totals,
    status: "active",
    version: 1,
  };
  const deletedMessage: ChatMessage = {
    id: crypto.randomUUID(),
    client_message_id: null,
    role: "assistant",
    text: "This meal was deleted.",
    cards: [{ kind: "meal", meal_id: crypto.randomUUID(), meal: null }],
    had_image: false,
    status: "sent",
    created_at: now.toISOString(),
  };
  return { single, three, photo, clarification, autoSaved, deletedMessage };
}
