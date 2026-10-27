"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { formatInTimeZone } from "date-fns-tz";
import * as api from "@/lib/api";
import type { DailySummary } from "@/types/api";

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
  return useInfiniteQuery({
    queryKey: queryKeys.messages,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.getMessages({ before: pageParam }, { signal }),
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
      if (result.daily_summary) await update([result.daily_summary]);
      else void client.invalidateQueries({ queryKey: queryKeys.messages });
    },
  });
}
export function useSaveMeals() {
  const update = useMealResult();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (action: ReturnType<typeof api.createSaveAction>) =>
      api.saveMeals(action),
    onSuccess: async (result) => {
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
  return useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: Parameters<typeof api.updateMeal>[1];
    }) => api.updateMeal(id, body),
    onSuccess: (result) => update(result.daily_summaries),
  });
}
export function useDeleteMeal() {
  const update = useMealResult();
  return useMutation({
    mutationFn: (id: string) => api.deleteMeal(id),
    onSuccess: (result) => update([result.daily_summary]),
  });
}
export function useUndoDelete() {
  const update = useMealResult();
  return useMutation({
    mutationFn: (id: string) => api.undoDelete(id),
    onSuccess: (result) => update([result.daily_summary]),
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
