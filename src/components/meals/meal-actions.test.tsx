// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { useSendChat, queryKeys } from "@/hooks/use-api";
import { createFixtures } from "@/mocks/fixtures";
import { MealUndoNotices } from "./meal-actions";
import { MessageMealCards } from "./message-meal-cards";
import type { ChatMessage } from "@/types/api";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof api>()),
  deleteMeal: vi.fn(),
  undoDelete: vi.fn(),
  sendChat: vi.fn(),
  getDaily: vi.fn(),
}));
const f = createFixtures(new Date("2026-10-26T12:00:00Z"));
const reply: ChatMessage = {
  id: "auto-reply",
  client_message_id: null,
  role: "assistant",
  text: "",
  cards: [{ kind: "meal", meal_id: f.autoSaved.id, meal: f.autoSaved }],
  had_image: false,
  status: "sent",
  created_at: f.autoSaved.created_at,
};
const daily = {
  date: "2026-10-26",
  timezone: "UTC",
  consumed: f.autoSaved.totals,
  targets: null,
  remaining: null,
  meals: [],
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
  vi.mocked(api.getDaily).mockResolvedValue(daily);
  vi.mocked(api.deleteMeal).mockImplementation(async () => ({
    undo_until: new Date(Date.now() + 5_000).toISOString(),
    daily_summary: {
      ...daily,
      consumed: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
    },
  }));
  vi.mocked(api.undoDelete).mockResolvedValue({
    meal: f.autoSaved,
    daily_summary: daily,
  });
  vi.mocked(api.sendChat).mockResolvedValue({
    user_message: { ...reply, id: "user", role: "user", cards: [] },
    assistant_message: reply,
    daily_summary: daily,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function Controls() {
  const chat = useSendChat();
  return (
    <>
      <button
        onClick={() =>
          void chat.mutateAsync({
            client_message_id: "same-id",
            timezone: "UTC",
            text: "Eggs",
          })
        }
      >
        Receive auto-save
      </button>
      <MessageMealCards message={reply} onClarify={() => {}} />
      <MealUndoNotices />
    </>
  );
}
function mount() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(queryKeys.daily(), daily);
  render(
    <QueryClientProvider client={client}>
      <Controls />
    </QueryClientProvider>,
  );
  return client;
}
it("does not offer auto-save undo for old history, and replaying a turn cannot extend its 10 seconds", async () => {
  mount();
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByText("Receive auto-save"));
  });
  await screen.findByRole("button", { name: "Undo" });
  act(() => vi.advanceTimersByTime(6000));
  await act(async () => {
    fireEvent.click(screen.getByText("Receive auto-save"));
  });
  await waitFor(() => expect(api.sendChat).toHaveBeenCalledTimes(2));
  act(() => vi.advanceTimersByTime(4250));
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  expect(screen.getByRole("button", { name: "Delete meal" })).toBeTruthy();
});
it("deletes on auto-save Undo, restores through the deletion toast, and applies returned totals without a daily fetch", async () => {
  const client = mount();
  fireEvent.click(screen.getByText("Receive auto-save"));
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await screen.findByText("This meal was deleted.");
  expect(client.getQueryData(queryKeys.daily())).toMatchObject({
    consumed: { calories: 0 },
  });
  const notice = screen.getByRole("complementary", {
    name: "Meal deletion notifications",
  });
  fireEvent.click(within(notice).getByRole("button", { name: "Undo" }));
  await screen.findByRole("button", { name: "Delete meal" });
  expect(client.getQueryData(queryKeys.daily())).toEqual(daily);
  expect(api.deleteMeal).toHaveBeenCalledTimes(1);
  expect(api.undoDelete).toHaveBeenCalledWith(f.autoSaved.id);
  expect(api.getDaily).not.toHaveBeenCalled();
});
it("uses the server deadline and removes Undo at expiry", async () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Delete meal" }));
  await screen.findByText("Meal deleted");
  act(() => vi.advanceTimersByTime(5250));
  expect(screen.queryByText("Meal deleted")).toBeNull();
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  expect(api.undoDelete).not.toHaveBeenCalled();
});
it("keeps a failed delete actionable and retries a failed restore within its deadline", async () => {
  vi.mocked(api.deleteMeal).mockRejectedValueOnce(new Error("Delete offline"));
  vi.mocked(api.undoDelete).mockRejectedValueOnce(new Error("Restore offline"));
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Delete meal" }));
  await screen.findByText("Delete offline");
  expect(screen.getByRole("region", { name: f.autoSaved.name })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry delete" }));
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await screen.findByText("Restore offline");
  fireEvent.click(screen.getByRole("button", { name: "Retry undo" }));
  await screen.findByRole("button", { name: "Delete meal" });
  expect(api.undoDelete).toHaveBeenCalledTimes(2);
});
it("prevents duplicate deletes while the original request is pending", async () => {
  let finish!: (value: Awaited<ReturnType<typeof api.deleteMeal>>) => void;
  vi.mocked(api.deleteMeal).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  mount();
  const button = screen.getByRole("button", { name: "Delete meal" });
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(api.deleteMeal).toHaveBeenCalledTimes(1));
  await act(async () =>
    finish({
      undo_until: new Date(Date.now() + 5000).toISOString(),
      daily_summary: daily,
    }),
  );
  await screen.findByText("Meal deleted");
});
it("explains an expired server undo instead of offering another restore", async () => {
  vi.mocked(api.undoDelete).mockRejectedValueOnce(
    new api.ApiClientError("not_found", "Expired", false, 404),
  );
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Delete meal" }));
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  act(() => vi.advanceTimersByTime(250));
  await screen.findByText("The undo window ended. This meal remains deleted.");
  expect(screen.queryByRole("button", { name: "Retry undo" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await waitFor(() =>
    expect(
      screen.queryByText("The undo window ended. This meal remains deleted."),
    ).toBeNull(),
  );
});
