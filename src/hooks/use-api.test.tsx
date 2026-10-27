// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { useDaily, useSaveMeals, useSendChat, queryKeys } from "./use-api";
import * as api from "@/lib/api";
import type { DailySummary, ChatMessage } from "@/types/api";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  getDaily: vi.fn(),
  saveMeals: vi.fn(),
  sendChat: vi.fn(),
}));

it("inserts chat responses immediately and deduplicates retries without removing unrelated assistants", async () => {
  const client = new QueryClient();
  const old: ChatMessage = {
    id: "older",
    client_message_id: null,
    role: "assistant",
    text: "Earlier answer",
    cards: [],
    had_image: false,
    status: "sent",
    created_at: "2026-10-26T00:00:00Z",
  };
  const user: ChatMessage = {
    ...old,
    id: "user",
    role: "user",
    text: "Eggs",
    client_message_id: "stable",
  };
  const reply: ChatMessage = { ...old, id: "reply", text: "New answer" };
  client.setQueryData(queryKeys.messages, {
    pages: [{ messages: [old], has_more: true }],
    pageParams: [undefined],
  });
  vi.mocked(api.sendChat).mockResolvedValue({
    user_message: user,
    assistant_message: reply,
    daily_summary: null,
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useSendChat(), { wrapper });
  await act(async () => {
    await hook.result.current.mutateAsync({
      client_message_id: "stable",
      text: "Eggs",
      timezone: "UTC",
    });
    await hook.result.current.mutateAsync({
      client_message_id: "stable",
      text: "Eggs",
      timezone: "UTC",
    });
  });
  expect(client.getQueryData(queryKeys.messages)).toEqual({
    pages: [{ messages: [old, user, reply], has_more: true }],
    pageParams: [undefined],
  });
  hook.unmount();
  client.clear();
});

it("updates an active daily query from the mutation response without refetching it", async () => {
  const consumed = { calories: 320, protein_g: 20, carbs_g: 30, fat_g: 14 };
  const summary: DailySummary = {
    date: "2026-10-26",
    timezone: "UTC",
    consumed,
    targets: null,
    remaining: null,
    meals: [],
  };
  const client = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(queryKeys.daily(summary.date), {
    ...summary,
    consumed: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
  });
  vi.mocked(api.saveMeals).mockResolvedValue({
    meals: [],
    daily_summary: summary,
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () => ({ daily: useDaily(summary.date), save: useSaveMeals() }),
    { wrapper },
  );
  await act(async () => {
    await hook.result.current.save.mutateAsync({
      body: { meals: [] },
      idempotencyKey: "test",
    });
  });
  await waitFor(() =>
    expect(hook.result.current.daily.data?.consumed.calories).toBe(320),
  );
  expect(api.getDaily).not.toHaveBeenCalled();
  hook.unmount();
  client.clear();
});

it("invalidates today's alias when a multi-day save returns only an older day's summary", async () => {
  const macros = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  const summary: DailySummary = {
    date: "2000-01-01",
    timezone: "UTC",
    consumed: macros,
    targets: null,
    remaining: null,
    meals: [],
  };
  const now = new Date().toISOString();
  const client = new QueryClient();
  client.setQueryData(queryKeys.daily(), {
    ...summary,
    date: now.slice(0, 10),
  });
  client.setQueryData(queryKeys.daily(now.slice(0, 10)), {
    ...summary,
    date: now.slice(0, 10),
  });
  vi.mocked(api.saveMeals).mockResolvedValue({
    meals: [
      {
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Today's meal",
        consumed_at: now,
        created_at: now,
        updated_at: now,
        source_type: "manual",
        items: [],
        totals: macros,
        status: "active",
        version: 1,
      },
    ],
    daily_summary: summary,
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useSaveMeals(), { wrapper });
  await act(async () => {
    await hook.result.current.mutateAsync({
      body: { meals: [] },
      idempotencyKey: "test",
    });
  });
  expect(client.getQueryState(queryKeys.daily())?.isInvalidated).toBe(true);
  expect(
    client.getQueryState(queryKeys.daily(now.slice(0, 10)))?.isInvalidated,
  ).toBe(true);
  expect(client.getQueryData(queryKeys.daily(summary.date))).toEqual(summary);
  hook.unmount();
  client.clear();
});
