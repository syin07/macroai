"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { formatInTimeZone } from "date-fns-tz";
import * as api from "@/lib/api";
import type {
  DailySummary,
  MessagesPage,
  Meal,
  ChatMessage,
} from "@/types/api";

export type MealActionState = {
  meal?: Meal | null;
  autoUntil?: number;
  undoUntil?: number;
  busy?: "delete" | "undo";
  error?: string;
};
const mealActionsKey = ["meal-actions"] as const;
const emptyActions: Record<string, MealActionState> = {};
export function useMealActions() {
  return useQuery({
    queryKey: mealActionsKey,
    queryFn: () => emptyActions,
    initialData: emptyActions,
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  }).data;
}
function changeMealAction(
  client: QueryClient,
  id: string,
  patch: Partial<MealActionState>,
) {
  client.setQueryData<Record<string, MealActionState>>(
    mealActionsKey,
    (old) => ({ ...old, [id]: { ...old?.[id], ...patch } }),
  );
}
export function useManualMessages() {
  return useQuery({
    queryKey: ["manual-messages"],
    queryFn: (): ChatMessage[] => [],
    initialData: [] as ChatMessage[],
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  }).data;
}

export const queryKeys = {
  daily: (date?: string) => ["daily", date ?? "today"] as const,
  messages: ["messages"] as const,
  meals: (filters: Omit<api.MealFilters, "cursor"> = {}) =>
    ["meals", filters] as const,
  meal: (id: string) => ["meal", id] as const,
  me: ["me"] as const,
  preferences: ["preferences"] as const,
  goals: ["goals"] as const,
  memories: ["memories"] as const,
};

export function applyDailySummaries(
  client: QueryClient,
  summaries: DailySummary[],
) {
  for (const summary of summaries) {
    client.setQueryData(queryKeys.daily(summary.date), summary);
    if (
      formatInTimeZone(new Date(), summary.timezone, "yyyy-MM-dd") ===
      summary.date
    )
      client.setQueryData(queryKeys.daily(), summary);
  }
}
function useMealResult() {
  const client = useQueryClient();
  return async (summaries: DailySummary[]) => {
    await client.cancelQueries({ queryKey: queryKeys.messages });
    for (const summary of summaries) {
      await client.cancelQueries({
        queryKey: queryKeys.daily(summary.date),
        exact: true,
      });
      if (
        formatInTimeZone(new Date(), summary.timezone, "yyyy-MM-dd") ===
        summary.date
      )
        await client.cancelQueries({
          queryKey: queryKeys.daily(),
          exact: true,
        });
    }
    applyDailySummaries(client, summaries);
    void client.invalidateQueries({ queryKey: ["meals"] });
    void client.invalidateQueries({ queryKey: ["meal"] });
    void client.invalidateQueries({ queryKey: queryKeys.messages });
  };
}

export const useDaily = (date?: string) =>
  useQuery({
    queryKey: queryKeys.daily(date),
    queryFn: ({ signal }) => api.getDaily(date, { signal }),
  });
export const useMe = () =>
  useQuery({
    queryKey: queryKeys.me,
    queryFn: ({ signal }) => api.getMe({ signal }),
  });
export const usePreferences = () =>
  useQuery({
    queryKey: queryKeys.preferences,
    queryFn: ({ signal }) => api.getPreferences({ signal }),
  });
export const useGoals = () =>
  useQuery({
    queryKey: queryKeys.goals,
    queryFn: ({ signal }) => api.getGoals({ signal }),
  });
export const useMemories = () =>
  useQuery({
    queryKey: queryKeys.memories,
    queryFn: ({ signal }) => api.getMemories({ signal }),
  });
export const useMeal = (id: string) =>
  useQuery({
    queryKey: queryKeys.meal(id),
    queryFn: ({ signal }) => api.getMeal(id, { signal }),
    enabled: !!id,
  });
export function useMessages() {
  const client = useQueryClient();
  return useInfiniteQuery({
    queryKey: queryKeys.messages,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const page = await api.getMessages({ before: pageParam }, { signal });
      if (!signal.aborted) {
        const actions =
          client.getQueryData<Record<string, MealActionState>>(mealActionsKey);
        for (const message of page.messages)
          for (const card of message.cards) {
            if (card.kind !== "meal") continue;
            const state = actions?.[card.meal_id];
            if (
              state?.meal &&
              !state.busy &&
              (!card.meal || card.meal.version >= state.meal.version)
            )
              changeMealAction(client, card.meal_id, { meal: card.meal });
          }
      }
      return page;
    },
    getNextPageParam: (page) =>
      page.has_more ? page.messages[0]?.id : undefined,
    select: (data) => ({
      ...data,
      messages: [...data.pages].reverse().flatMap((page) => page.messages),
    }),
  });
}
export function useMeals(filters: Omit<api.MealFilters, "cursor"> = {}) {
  return useInfiniteQuery({
    queryKey: queryKeys.meals(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.getMeals({ ...filters, cursor: pageParam }, { signal }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
}

export function useSendChat() {
  const update = useMealResult();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (draft: api.ChatDraft) => api.sendChat(draft),
    onSuccess: async (result) => {
      // Register only newly received turns. Replaying the same chat ID must not restart Undo.
      const receivedKey = ["received-turn", result.assistant_message.id];
      if (!client.getQueryData(receivedKey)) {
        client.setQueryData(receivedKey, true);
        for (const card of result.assistant_message.cards) {
          if (
            card.kind === "meal" &&
            card.meal?.status === "active" &&
            !client.getQueryData<Record<string, MealActionState>>(
              mealActionsKey,
            )?.[card.meal_id]
          )
            changeMealAction(client, card.meal_id, {
              autoUntil: Date.now() + 10_000,
            });
        }
      }
      await client.cancelQueries({ queryKey: queryKeys.messages });
      client.setQueryData<InfiniteData<MessagesPage>>(
        queryKeys.messages,
        (old) => {
          if (!old)
            return {
              pages: [
                {
                  messages: [result.user_message, result.assistant_message],
                  has_more: false,
                },
              ],
              pageParams: [undefined],
            };
          const ids = new Set([
            result.user_message.id,
            result.assistant_message.id,
          ]);
          return {
            ...old,
            pages: old.pages.map((page, index) => ({
              ...page,
              messages: [
                ...page.messages.filter(
                  (message) =>
                    !ids.has(message.id) &&
                    (!result.user_message.client_message_id ||
                      message.client_message_id !==
                        result.user_message.client_message_id),
                ),
                ...(index === 0
                  ? [result.user_message, result.assistant_message]
                  : []),
              ],
            })),
          };
        },
      );
      if (result.daily_summary) await update([result.daily_summary]);
    },
  });
}
export function useSaveMeals() {
  const update = useMealResult();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (action: ReturnType<typeof api.createSaveAction>) =>
      api.saveMeals(action),
    onSuccess: async (result, action) => {
      const manual = result.meals.filter(
        (meal) =>
          action.body.meals.some(
            (input) => input.source_type === "manual" && !input.proposal_id,
          ) && meal.source_type === "manual",
      );
      if (manual.length) {
        client.setQueryData<ChatMessage[]>(["manual-messages"], (old = []) => {
          const id = `manual:${action.idempotencyKey}`;
          return [
            ...old.filter((message) => message.id !== id),
            {
              id,
              client_message_id: null,
              role: "assistant",
              text: "",
              had_image: false,
              status: "sent",
              created_at: manual[0].created_at,
              cards: manual.map((meal) => ({
                kind: "meal" as const,
                meal_id: meal.id,
                meal,
              })),
            },
          ];
        });
      }
      await update([result.daily_summary]);
      // The contract returns one summary for a multi-day save; only other days need refetching.
      for (const meal of result.meals) {
        const date = formatInTimeZone(
          meal.consumed_at,
          result.daily_summary.timezone,
          "yyyy-MM-dd",
        );
        if (date !== result.daily_summary.date) {
          void client.invalidateQueries({ queryKey: queryKeys.daily(date) });
          if (
            date ===
            formatInTimeZone(
              new Date(),
              result.daily_summary.timezone,
              "yyyy-MM-dd",
            )
          ) {
            void client.invalidateQueries({ queryKey: queryKeys.daily() });
          }
        }
      }
    },
  });
}
export function useUpdateMeal() {
  const update = useMealResult();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: Parameters<typeof api.updateMeal>[1];
    }) => api.updateMeal(id, body),
    onSuccess: (result) => {
      changeMealAction(client, result.meal.id, { meal: result.meal });
      client.setQueryData(queryKeys.meal(result.meal.id), result.meal);
      return update(result.daily_summaries);
    },
  });
}
export function useDeleteMeal() {
  const update = useMealResult();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const state =
        client.getQueryData<Record<string, MealActionState>>(mealActionsKey)?.[
          id
        ];
      if (state?.busy) throw new Error("This meal is already changing.");
      if (state?.meal === null && state.undoUntil)
        throw new Error("This meal is already deleted.");
      changeMealAction(client, id, { busy: "delete", error: undefined });
      try {
        return await api.deleteMeal(id);
      } catch (error) {
        changeMealAction(client, id, {
          busy: undefined,
          error:
            error instanceof Error
              ? error.message
              : "Couldn’t delete. Try again.",
        });
        throw error;
      }
    },
    onSuccess: async (result, id) => {
      changeMealAction(client, id, {
        meal: null,
        autoUntil: undefined,
        undoUntil: Date.parse(result.undo_until),
        busy: undefined,
        error: undefined,
      });
      client.removeQueries({ queryKey: queryKeys.meal(id), exact: true });
      await update([result.daily_summary]);
    },
  });
}
export function useUndoDelete() {
  const update = useMealResult();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const state =
        client.getQueryData<Record<string, MealActionState>>(mealActionsKey)?.[
          id
        ];
      if (state?.busy) throw new Error("This meal is already changing.");
      if (!state?.undoUntil || state.undoUntil <= Date.now())
        throw new Error("The undo window has ended.");
      changeMealAction(client, id, { busy: "undo", error: undefined });
      try {
        return await api.undoDelete(id);
      } catch (error) {
        changeMealAction(client, id, {
          busy: undefined,
          error:
            error instanceof Error
              ? error.message
              : "Couldn’t restore. Retry before the window ends.",
          ...(error instanceof api.ApiClientError && error.code === "not_found"
            ? { undoUntil: Date.now() }
            : {}),
        });
        throw error;
      }
    },
    onSuccess: async (result, id) => {
      changeMealAction(client, id, {
        meal: result.meal,
        undoUntil: undefined,
        busy: undefined,
        error: undefined,
      });
      client.setQueryData(queryKeys.meal(id), result.meal);
      await update([result.daily_summary]);
    },
  });
}
export function usePatchPreferences() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.patchPreferences>[0]) =>
      api.patchPreferences(body),
    onSuccess: (result) => {
      client.setQueryData(queryKeys.preferences, result);
      void client.invalidateQueries({ queryKey: ["daily"] });
      void client.invalidateQueries({ queryKey: ["meals"] });
    },
  });
}
export function usePutGoals() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.putGoals>[0]) =>
      api.putGoals(body),
    onSuccess: (result) => {
      client.setQueryData(queryKeys.goals, result);
      void client.invalidateQueries({ queryKey: ["daily"] });
    },
  });
}
