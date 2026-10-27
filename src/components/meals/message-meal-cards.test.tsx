// @vitest-environment jsdom
import {
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
import { queryKeys } from "@/hooks/use-api";
import { createFixtures, sumMockMacros } from "@/mocks/fixtures";
import type { ChatMessage, DailySummary } from "@/types/api";
import { MessageMealCards } from "./message-meal-cards";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof api>()),
  saveMeals: vi.fn(),
  getDaily: vi.fn(),
}));
const f = createFixtures(new Date("2026-10-26T12:30:00Z"));
const daily: DailySummary = {
  date: "2026-10-26",
  timezone: "UTC",
  consumed: { calories: 1500, protein_g: 100, carbs_g: 150, fat_g: 55 },
  targets: null,
  remaining: null,
  meals: [],
};
const message = (three = false): ChatMessage => ({
  id: "assistant",
  role: "assistant",
  client_message_id: null,
  text: "Estimate",
  cards: (three ? f.three : [f.single]).map((proposal) => ({
    kind: "proposal",
    state: "unsaved",
    proposal,
  })),
  had_image: false,
  status: "sent",
  created_at: f.single.consumed_at,
});
const saved = (action: ReturnType<typeof api.createSaveAction>) => ({
  meals: action.body.meals.map((input, index) => ({
    ...input,
    id: `saved-${index}`,
    created_at: f.single.consumed_at,
    updated_at: f.single.consumed_at,
    status: "active" as const,
    version: 1,
    totals: sumMockMacros(input.items.map((item) => item.macros)),
    items: input.items.map((item, itemIndex) => ({
      ...item,
      id: `item-${index}-${itemIndex}`,
    })),
  })),
  daily_summary: daily,
});
beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.clearAllMocks();
  vi.mocked(api.getDaily).mockResolvedValue(daily);
  vi.mocked(api.saveMeals).mockImplementation(async (action) => saved(action));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount(
  msg = message(),
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  }),
) {
  const view = render(
    <QueryClientProvider client={client}>
      <MessageMealCards message={msg} onClarify={vi.fn()} sourceType="photo" />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

it("saves one proposal with its proposal ID and authoritative daily totals", async () => {
  const { client } = mount();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Saved");
  const action = vi.mocked(api.saveMeals).mock.calls[0][0];
  expect(action.idempotencyKey).toBe(f.single.proposal_id);
  expect(action.body.meals).toHaveLength(1);
  expect(action.body.meals[0].source_type).toBe("photo");
  expect(action.body.meals[0].items[0]).not.toHaveProperty("id");
  expect(client.getQueryData(queryKeys.daily(daily.date))).toEqual(daily);
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
});
it("Save all sends one request, locks individual saves, and retries the same batch key after remount", async () => {
  vi.mocked(api.saveMeals).mockRejectedValueOnce(new Error("Offline"));
  const first = mount(message(true));
  fireEvent.click(screen.getByRole("button", { name: "Save all (3)" }));
  await screen.findByText("Offline");
  expect(
    screen
      .getAllByRole("button", { name: "Save" })
      .every((button) => (button as HTMLButtonElement).disabled),
  ).toBe(true);
  const original = vi.mocked(api.saveMeals).mock.calls[0][0];
  expect(original.body.meals).toHaveLength(3);
  expect(original.idempotencyKey).not.toBe(f.single.proposal_id);
  first.unmount();
  mount(message(true), first.client);
  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  await waitFor(() => expect(screen.getAllByText("Saved")).toHaveLength(3));
  expect(api.saveMeals).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.saveMeals).mock.calls[1][0]).toEqual(original);
});
it("does not allow Save all to race a pending individual save", async () => {
  vi.mocked(api.saveMeals).mockImplementation(() => new Promise(() => {}));
  mount(message(true));
  fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
  await screen.findByText("Saving…");
  expect(
    (screen.getByRole("button", { name: "Save all (3)" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Save all (3)" }));
  expect(api.saveMeals).toHaveBeenCalledTimes(1);
});
it("discarding a proposal excludes it from Save all and survives a server-prop refresh and navigation", async () => {
  const first = mount(message(true));
  const eggs = screen.getByRole("region", { name: "Eggs and toast" });
  fireEvent.click(within(eggs).getByRole("button", { name: "Discard" }));
  expect(await screen.findByText("Discarded · Eggs and toast")).toBeTruthy();
  first.unmount();
  mount(message(true), first.client);
  fireEvent.click(screen.getByRole("button", { name: "Save all (2)" }));
  await waitFor(() => expect(screen.getAllByText("Saved")).toHaveLength(2));
  expect(
    vi
      .mocked(api.saveMeals)
      .mock.calls[0][0].body.meals.map((meal) => meal.proposal_id),
  ).not.toContain(f.single.proposal_id);
});
it("saves edited proposal details through the full editor", async () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Meal name"), {
    target: { value: "Late breakfast" },
  });
  fireEvent.change(screen.getByLabelText("Consumed at"), {
    target: { value: "2026-10-25T09:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save meal" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("region", { name: "Late breakfast" })).toBeTruthy();
  expect(api.saveMeals).toHaveBeenCalledTimes(1);
  await screen.findByText("Saved");
  const input = vi.mocked(api.saveMeals).mock.calls[0][0].body.meals[0];
  expect(input.name).toBe("Late breakfast");
  expect(input.consumed_at).toBe(new Date("2026-10-25T09:00").toISOString());
  expect(input.items[0].macros).toEqual(f.single.items[0].macros);
});
it("lets validation failures be revised without changing proposal identity", async () => {
  vi.mocked(api.saveMeals).mockRejectedValueOnce(
    new api.ApiClientError(
      "validation_error",
      "Check the meal name",
      false,
      400,
    ),
  );
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Check the meal name");
  fireEvent.click(screen.getByRole("button", { name: "Review before saving" }));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

it("loads missing original-message context before allowing a proposal save", async () => {
  const client = new QueryClient();
  const load = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <MessageMealCards
        message={message()}
        sourceType={null}
        onClarify={vi.fn()}
        onLoadContext={load}
      />
    </QueryClientProvider>,
  );
  expect(
    (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: "Load original message" }),
  );
  expect(load).toHaveBeenCalledOnce();
  expect(api.saveMeals).not.toHaveBeenCalled();
});
