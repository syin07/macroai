import { formatInTimeZone } from "date-fns-tz";
import { z } from "zod";
import type {
  ChatMessage,
  ChatResponse,
  DailySummary,
  ErrorCode,
  Macros,
  Meal,
  MealProposal,
  Me,
  Memory,
  NutritionGoals,
  Preferences,
  SaveMealsRequest,
  SaveMealsResponse,
} from "@/types/api";
import {
  chatFormSchema,
  imageFileSchema,
  isImageTooLarge,
  messagesQuerySchema,
} from "@/lib/validation/chat";
import {
  dailyQuerySchema,
  mealsQuerySchema,
  saveMealsRequestSchema,
  updateMealRequestSchema,
} from "@/lib/validation/meal";
import {
  putGoalsRequestSchema,
  suggestGoalsRequestSchema,
} from "@/lib/validation/goals";
import { patchPreferencesRequestSchema } from "@/lib/validation/preferences";
import {
  deleteAccountRequestSchema,
  exportQuerySchema,
  patchMemoryRequestSchema,
} from "@/lib/validation/account";
import { zodErrorToFields } from "@/lib/validation/errors";
import {
  createFixtures,
  errorFixtures,
  errorStatuses,
  sumMockMacros,
} from "./fixtures";

class MockFailure extends Error {
  constructor(public code: ErrorCode) {
    super(code);
  }
}
const json = (value: unknown, status = 200) => Response.json(value, { status });
const copy = <T>(value: T): T => structuredClone(value);

export function createMockApi(
  options: {
    now?: () => Date;
    aiDelay?: () => number;
    seedCount?: number;
  } = {},
) {
  const now = options.now ?? (() => new Date());
  const aiDelay =
    options.aiDelay ?? (() => 600 + Math.floor(Math.random() * 901));
  let fixtures = createFixtures(now());
  let meals = new Map<string, Meal>();
  let messages: ChatMessage[] = [];
  let preferences: Preferences;
  let goals: NutritionGoals[];
  let me: Me;
  let memories: Memory[];
  const deleted = new Map<string, number>();
  const saves = new Map<string, SaveMealsResponse>();
  const chats = new Map<string, ChatResponse>();
  // Reserve in-flight IDs too: concurrent retries must not duplicate a turn.
  const pendingChats = new Map<string, Promise<Response>>();
  let nextError: ErrorCode | undefined;

  function dateOf(value: string | Date) {
    return formatInTimeZone(value, preferences.timezone, "yyyy-MM-dd");
  }
  function reset() {
    fixtures = createFixtures(now());
    preferences = {
      theme: "system",
      save_mode: "confirm",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      assistant_style: "casual",
    };
    me = {
      user_id: crypto.randomUUID(),
      email: "ken@example.com",
      display_name: "Ken",
      approved: true,
      onboarding_complete: false,
    };
    goals = [
      {
        calories: 2200,
        protein_g: 150,
        carbs_g: 250,
        fat_g: 65,
        effective_from: "2000-01-01",
      },
    ];
    memories = [
      {
        id: crypto.randomUUID(),
        category: "frequent_food",
        content: "Usual shake: Fairlife Core Power 26g, 1 bottle",
        created_at: now().toISOString(),
        updated_at: now().toISOString(),
      },
    ];
    meals = new Map();
    messages = [];
    deleted.clear();
    saves.clear();
    chats.clear();
    pendingChats.clear();
    nextError = undefined;
    for (let i = 0; i < (options.seedCount ?? 205); i++) {
      const meal = copy(fixtures.autoSaved);
      meal.id = crypto.randomUUID();
      meal.items = meal.items.map((item) => ({
        ...item,
        id: crypto.randomUUID(),
      }));
      if (i % 2) {
        meal.name = fixtures.three[1].name;
        meal.items = fixtures.three[1].items.map((item) => ({
          ...copy(item),
          id: crypto.randomUUID(),
        }));
        meal.totals = copy(fixtures.three[1].totals);
      }
      meal.consumed_at = new Date(
        now().getTime() - i * 8 * 60 * 60 * 1000,
      ).toISOString();
      meals.set(meal.id, meal);
      if (i < 65)
        messages.push({
          id: crypto.randomUUID(),
          client_message_id: null,
          role: "assistant",
          text: "Saved meal.",
          cards: [{ kind: "meal", meal_id: meal.id, meal }],
          had_image: false,
          status: "sent",
          created_at: meal.consumed_at,
        });
    }
    messages.push(copy(fixtures.deletedMessage));
    messages.sort(
      (a, b) =>
        a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
    );
  }
  function purge() {
    for (const [id, until] of deleted)
      if (now().getTime() >= until) {
        meals.delete(id);
        deleted.delete(id);
      }
  }
  function requireMeal(id: string, allowDeleted = false) {
    const meal = meals.get(id);
    if (!meal || (!allowDeleted && meal.status !== "active"))
      throw new MockFailure("not_found");
    return meal;
  }
  function summary(date = dateOf(now())): DailySummary {
    const active = [...meals.values()]
      .filter(
        (meal) => meal.status === "active" && dateOf(meal.consumed_at) === date,
      )
      .sort(
        (a, b) =>
          Date.parse(a.consumed_at) - Date.parse(b.consumed_at) ||
          a.id.localeCompare(b.id),
      );
    const consumed = sumMockMacros(active.map((meal) => meal.totals));
    const target = [...goals]
      .reverse()
      .filter((goal) => goal.effective_from <= date)
      .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];
    const targets: Macros | null = target
      ? {
          calories: target.calories,
          protein_g: target.protein_g,
          carbs_g: target.carbs_g,
          fat_g: target.fat_g,
        }
      : null;
    const remaining = targets
      ? {
          calories: targets.calories - consumed.calories,
          protein_g: targets.protein_g - consumed.protein_g,
          carbs_g: targets.carbs_g - consumed.carbs_g,
          fat_g: targets.fat_g - consumed.fat_g,
        }
      : null;
    return {
      date,
      timezone: preferences.timezone,
      consumed,
      targets,
      remaining,
      meals: active.map(({ id, name, consumed_at, totals }) => ({
        id,
        name,
        consumed_at,
        totals,
      })),
    };
  }
  function normalizeItems(items: SaveMealsRequest["meals"][number]["items"]) {
    return items.map((item) => {
      const macros =
        item.basis_per_100g && item.grams !== null
          ? (Object.fromEntries(
              Object.entries(item.basis_per_100g).map(([key, value]) => [
                key,
                (value * item.grams!) / 100,
              ]),
            ) as unknown as Macros)
          : item.macros;
      return {
        ...copy(item),
        id:
          "id" in item && typeof item.id === "string"
            ? item.id
            : crypto.randomUUID(),
        macros,
      };
    });
  }
  function save(body: SaveMealsRequest, key: string): SaveMealsResponse {
    if (saves.has(key)) return copy(saves.get(key)!);
    const saved = body.meals.map((input) => {
      const items = normalizeItems(input.items);
      const meal: Meal = {
        id: crypto.randomUUID(),
        name: input.name,
        consumed_at: input.consumed_at,
        source_type: input.source_type,
        items,
        totals: sumMockMacros(items.map((item) => item.macros)),
        status: "active",
        version: 1,
        created_at: now().toISOString(),
        updated_at: now().toISOString(),
      };
      meals.set(meal.id, meal);
      if (input.proposal_id) {
        for (const message of messages)
          message.cards = message.cards.map((card) =>
            card.kind === "proposal" &&
            card.proposal.proposal_id === input.proposal_id
              ? { kind: "meal", meal_id: meal.id, meal }
              : card,
          );
      }
      return meal;
    });
    const response = {
      meals: saved,
      daily_summary: summary(dateOf(saved[0].consumed_at)),
    };
    saves.set(key, copy(response));
    return response;
  }
  function rehydrate(message: ChatMessage): ChatMessage {
    return {
      ...message,
      cards: message.cards.map((card) =>
        card.kind === "meal"
          ? {
              ...card,
              meal:
                meals.get(card.meal_id)?.status === "active"
                  ? meals.get(card.meal_id)!
                  : null,
            }
          : card,
      ),
    };
  }

  async function chat(request: Request): Promise<Response> {
    const form = await request.formData();
    const input = chatFormSchema.parse(
      Object.fromEntries(
        ["client_message_id", "text", "timezone"].map((key) => [
          key,
          form.get(key) ?? undefined,
        ]),
      ),
    );
    if (chats.has(input.client_message_id))
      return json(chats.get(input.client_message_id));
    const pending = pendingChats.get(input.client_message_id);
    if (pending) return (await pending).clone();
    const image = form.get("image");
    if (image instanceof Blob && isImageTooLarge(image))
      throw new MockFailure("payload_too_large");
    if (image !== null) imageFileSchema.parse(image);
    if (!input.text && !image) throw new MockFailure("validation_error");
    const run = async () => {
      await new Promise<void>((resolve, reject) => {
        if (request.signal.aborted) return reject(request.signal.reason);
        const abort = () => {
          clearTimeout(timer);
          reject(request.signal.reason);
        };
        const timer = setTimeout(() => {
          request.signal.removeEventListener("abort", abort);
          resolve();
        }, aiDelay());
        request.signal.addEventListener("abort", abort, { once: true });
      });
      const text = input.text ?? "";
      const user: ChatMessage = {
        id: crypto.randomUUID(),
        client_message_id: input.client_message_id,
        role: "user",
        text,
        cards: [],
        had_image: image instanceof Blob,
        status: "sent",
        created_at: now().toISOString(),
      };
      // Fixtures demonstrate UI states, not AI interpretation.
      const f = createFixtures(now());
      let proposals: MealProposal[] =
        /should I|how much|what did|remaining/i.test(text)
          ? []
          : image
            ? [f.photo]
            : /three meals|breakfast.*lunch.*dinner/i.test(text)
              ? f.three
              : /not sure|some chicken|clarify/i.test(text)
                ? [f.clarification]
                : [f.single];
      // Apply the supplied time zone to date interpretation without persisting image bytes.
      proposals = proposals.map((proposal) => ({
        ...proposal,
        consumed_at: now().toISOString(),
      }));
      const assistant: ChatMessage = {
        id: crypto.randomUUID(),
        client_message_id: null,
        role: "assistant",
        text: proposals.length
          ? "Here's a mock meal estimate."
          : "Mock response: your saved totals are available in the daily summary.",
        cards: [],
        had_image: false,
        status: "sent",
        created_at: now().toISOString(),
      };
      let daily: DailySummary | null = null;
      for (const proposal of proposals) {
        if (preferences.save_mode === "auto" && !proposal.needs_clarification) {
          const result = save(
            { meals: [{ ...proposal, source_type: image ? "photo" : "text" }] },
            proposal.proposal_id,
          );
          assistant.cards.push({
            kind: "meal",
            meal_id: result.meals[0].id,
            meal: result.meals[0],
          });
          daily = result.daily_summary;
          assistant.text = "Saved your mock meal.";
        } else
          assistant.cards.push({
            kind: "proposal",
            state: "unsaved",
            proposal,
          });
      }
      messages.push(user, assistant);
      const result: ChatResponse = {
        user_message: user,
        assistant_message: assistant,
        daily_summary: daily,
      };
      chats.set(input.client_message_id, copy(result));
      return json(result);
    };
    const result = run();
    pendingChats.set(input.client_message_id, result);
    try {
      return (await result).clone();
    } finally {
      pendingChats.delete(input.client_message_id);
    }
  }

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url),
      path = url.pathname,
      method = request.method;
    const query = Object.fromEntries(url.searchParams);
    purge();
    if (nextError) {
      const code = nextError;
      nextError = undefined;
      throw new MockFailure(code);
    }
    if (!me.approved) throw new MockFailure("unauthenticated");
    if (path === "/api/ai/chat" && method === "POST") return chat(request);
    if (path === "/api/messages" && method === "GET") {
      const { before, limit } = messagesQuerySchema.parse(query);
      const end = before
        ? messages.findIndex((message) => message.id === before)
        : messages.length;
      if (end < 0) throw new MockFailure("not_found");
      const start = Math.max(0, end - limit);
      return json({
        messages: messages.slice(start, end).map(rehydrate),
        has_more: start > 0,
      });
    }
    if (path.startsWith("/api/messages/") && method === "DELETE") {
      const id = path.split("/")[3];
      if (!messages.some((message) => message.id === id))
        throw new MockFailure("not_found");
      messages = messages.filter((message) => message.id !== id);
      return new Response(null, { status: 204 });
    }
    if (path === "/api/meals" && method === "POST") {
      const key = z.uuid().parse(request.headers.get("Idempotency-Key"));
      const body = saveMealsRequestSchema.parse(await request.json());
      return json(save(body, key), 201);
    }
    if (path === "/api/meals" && method === "GET") {
      const filter = mealsQuerySchema.parse(query);
      const list = [...meals.values()]
        .filter(
          (meal) =>
            meal.status === "active" &&
            (!filter.from || dateOf(meal.consumed_at) >= filter.from) &&
            (!filter.to || dateOf(meal.consumed_at) <= filter.to) &&
            (!filter.q ||
              [meal.name, ...meal.items.map((item) => item.food_name)].some(
                (name) => name.toLowerCase().includes(filter.q!.toLowerCase()),
              )),
        )
        .sort(
          (a, b) =>
            Date.parse(b.consumed_at) - Date.parse(a.consumed_at) ||
            b.id.localeCompare(a.id),
        );
      const start = filter.cursor
        ? list.findIndex((meal) => meal.id === filter.cursor) + 1
        : 0;
      if (filter.cursor && !start) throw new MockFailure("validation_error");
      const page = list.slice(start, start + filter.limit);
      return json({
        meals: page.map(({ id, name, consumed_at, totals }) => ({
          id,
          name,
          consumed_at,
          totals,
        })),
        next_cursor:
          start + filter.limit < list.length ? page.at(-1)!.id : null,
      });
    }
    const match = path.match(/^\/api\/meals\/([^/]+)(\/undo)?$/);
    if (match) {
      const meal = requireMeal(match[1], !!match[2]);
      if (match[2] && method === "POST") {
        if (!deleted.has(meal.id)) throw new MockFailure("not_found");
        deleted.delete(meal.id);
        meal.status = "active";
        return json({ meal, daily_summary: summary(dateOf(meal.consumed_at)) });
      }
      if (!match[2] && method === "GET") return json(meal);
      if (!match[2] && method === "PATCH") {
        const input = updateMealRequestSchema.parse(await request.json());
        if (input.version !== meal.version)
          throw new MockFailure("version_conflict");
        const oldDate = dateOf(meal.consumed_at);
        if (input.name) meal.name = input.name;
        if (input.consumed_at) meal.consumed_at = input.consumed_at;
        if (input.items)
          meal.items = normalizeItems(input.items).map((item) => ({
            ...item,
            edited_by_user: true,
          }));
        meal.totals = sumMockMacros(meal.items.map((item) => item.macros));
        meal.version++;
        meal.updated_at = now().toISOString();
        return json({
          meal,
          daily_summaries: [
            ...new Set([oldDate, dateOf(meal.consumed_at)]),
          ].map((date) => summary(date)),
        });
      }
      if (!match[2] && method === "DELETE") {
        meal.status = "pending_deletion";
        const until = now().getTime() + 10000;
        deleted.set(meal.id, until);
        return json({
          undo_until: new Date(until).toISOString(),
          daily_summary: summary(dateOf(meal.consumed_at)),
        });
      }
    }
    if (path === "/api/nutrition/daily" && method === "GET")
      return json(summary(dailyQuerySchema.parse(query).date));
    if (path === "/api/me" && method === "GET") return json(me);
    if (path === "/api/onboarding/complete" && method === "POST") {
      me.onboarding_complete = true;
      return json(me);
    }
    if (path === "/api/preferences") {
      if (method === "GET") return json(preferences);
      if (method === "PATCH") {
        preferences = {
          ...preferences,
          ...patchPreferencesRequestSchema.parse(await request.json()),
        };
        return json(preferences);
      }
    }
    if (path === "/api/goals") {
      if (method === "GET") return json(goals.at(-1) ?? null);
      if (method === "PUT") {
        const goal = {
          ...putGoalsRequestSchema.parse(await request.json()),
          effective_from: dateOf(now()),
        };
        goals.push(goal);
        return json(goal);
      }
    }
    if (path === "/api/goals/suggest" && method === "POST") {
      suggestGoalsRequestSchema.parse(await request.json());
      return json({
        suggested: { calories: 2200, protein_g: 150, carbs_g: 250, fat_g: 65 },
        explanation:
          "Mock targets for preview only. Real suggestions come from the backend.",
      });
    }
    if (path === "/api/memories" && method === "GET") return json({ memories });
    if (path.startsWith("/api/memories/")) {
      const memory = memories.find(
        (memory) => memory.id === path.split("/")[3],
      );
      if (!memory) throw new MockFailure("not_found");
      if (method === "PATCH") {
        memory.content = patchMemoryRequestSchema.parse(
          await request.json(),
        ).content;
        memory.updated_at = now().toISOString();
        return json(memory);
      }
      if (method === "DELETE") {
        memories = memories.filter((item) => item.id !== memory.id);
        return new Response(null, { status: 204 });
      }
    }
    if (path === "/api/export" && method === "GET") {
      const { format, scope } = exportQuerySchema.parse(query);
      const active = [...meals.values()].filter(
        (meal) => meal.status === "active",
      );
      const escape = (value: unknown) =>
        `"${String(value).replaceAll('"', '""')}"`;
      const csv = [
        [
          "meal_id",
          "meal_name",
          "consumed_at",
          "food_name",
          "grams",
          "calories",
          "protein_g",
          "carbs_g",
          "fat_g",
        ],
        ...active.flatMap((meal) =>
          meal.items.map((item) => [
            meal.id,
            meal.name,
            meal.consumed_at,
            item.food_name,
            item.grams ?? "",
            item.macros.calories,
            item.macros.protein_g,
            item.macros.carbs_g,
            item.macros.fat_g,
          ]),
        ),
      ]
        .map((row) => row.map(escape).join(","))
        .join("\r\n");
      return new Response(
        format === "csv"
          ? csv
          : JSON.stringify({
              meals: active,
              ...(scope === "account"
                ? { messages: messages.map(rehydrate), memories }
                : {}),
            }),
        {
          headers: {
            "Content-Type": format === "csv" ? "text/csv" : "application/json",
            "Content-Disposition": `attachment; filename="macroai-${scope}.${format}"`,
          },
        },
      );
    }
    if (path === "/api/account" && method === "DELETE") {
      deleteAccountRequestSchema.parse(await request.json());
      meals.clear();
      messages = [];
      memories = [];
      saves.clear();
      chats.clear();
      goals = [];
      me.approved = false;
      return new Response(null, { status: 204 });
    }
    throw new MockFailure("not_found");
  }
  reset();
  return {
    reset,
    failNext(code: ErrorCode) {
      nextError = code;
    },
    async handle(request: Request): Promise<Response> {
      try {
        return await route(request);
      } catch (error) {
        if (request.signal.aborted) throw error;
        if (error instanceof z.ZodError)
          return json(
            {
              error: {
                ...errorFixtures.validation_error.error,
                fields: zodErrorToFields(error),
              },
            },
            400,
          );
        if (error instanceof MockFailure)
          return json(errorFixtures[error.code], errorStatuses[error.code]);
        return json(errorFixtures.internal, 500);
      }
    },
  };
}

export const mockApi = createMockApi();
