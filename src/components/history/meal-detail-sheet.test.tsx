// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { createFixtures } from "@/mocks/fixtures";
import { MealDetailSheet } from "./meal-detail-sheet";
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof api>()),
  getMeal: vi.fn(),
  updateMeal: vi.fn(),
  deleteMeal: vi.fn(),
}));
const meal = createFixtures(new Date("2026-10-26T12:00:00Z")).autoSaved;
const daily = {
  date: "2026-10-26",
  timezone: "UTC",
  consumed: meal.totals,
  targets: null,
  remaining: null,
  meals: [],
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.mocked(api.getMeal).mockResolvedValue(meal);
  vi.mocked(api.updateMeal).mockResolvedValue({
    meal: { ...meal, name: "Edited lunch", version: 2 },
    daily_summaries: [daily],
  });
  vi.mocked(api.deleteMeal).mockResolvedValue({
    undo_until: new Date(Date.now() + 10000).toISOString(),
    daily_summary: daily,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const close = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <MealDetailSheet
        id={meal.id}
        timezone="UTC"
        onClose={close}
        returnFocus={{ current: null }}
      />
    </QueryClientProvider>,
  );
  return { client, close };
}
it("opens the saved card expanded, edits through A7, and shows the returned meal", async () => {
  mount();
  await screen.findByRole("button", { name: `Collapse ${meal.name}` });
  expect(screen.getByRole("button", { name: /Edit grams for/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edit meal" }));
  fireEvent.change(await screen.findByLabelText("Meal name"), {
    target: { value: "Edited lunch" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByRole("button", { name: "Collapse Edited lunch" });
  expect(api.updateMeal).toHaveBeenCalledWith(
    meal.id,
    expect.objectContaining({ version: 1, name: "Edited lunch" }),
  );
});
it("keeps the sheet after a failed delete and closes only after a successful retry", async () => {
  vi.mocked(api.deleteMeal).mockRejectedValueOnce(new Error("Delete offline"));
  const { close } = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Delete meal" }));
  await screen.findByText("Delete offline");
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry delete" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(api.deleteMeal).toHaveBeenCalledWith(meal.id);
});
it("retries a failed detail request and handles deleted meals without editing", async () => {
  vi.mocked(api.getMeal)
    .mockRejectedValueOnce(new Error("Offline"))
    .mockRejectedValueOnce(
      new api.ApiClientError("not_found", "Deleted", false, 404),
    );
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Retry meal" }));
  await screen.findByText("This meal is no longer available.");
  expect(screen.queryByRole("button", { name: "Edit meal" })).toBeNull();
});
