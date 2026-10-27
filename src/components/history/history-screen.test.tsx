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
import { HistoryScreen } from "./history-screen";
import type { MealListItem } from "@/types/api";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof api>()),
  getPreferences: vi.fn(),
  getMeals: vi.fn(),
  getDaily: vi.fn(),
}));
const row = (
  id: string,
  name: string,
  date = "2026-10-27T01:00:00Z",
): MealListItem => ({
  id,
  name,
  consumed_at: date,
  totals: { calories: 320, protein_g: 20, carbs_g: 30, fat_g: 14 },
});
const first = row("one", "Yogurt");
const second = row("two", "Chicken", "2026-10-26T06:00:00Z");
const preferences = {
  timezone: "America/Los_Angeles",
  theme: "system" as const,
  save_mode: "confirm" as const,
  assistant_style: "casual" as const,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getPreferences).mockResolvedValue(preferences);
  vi.mocked(api.getMeals).mockResolvedValue({
    meals: [first],
    next_cursor: null,
  });
  vi.mocked(api.getDaily).mockImplementation(async (date) => ({
    date: date!,
    timezone: preferences.timezone,
    consumed: { calories: 999, protein_g: 70, carbs_g: 80, fat_g: 30 },
    targets: null,
    remaining: null,
    meals: [],
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <HistoryScreen />
    </QueryClientProvider>,
  );
  return client;
}
it("uses an authoritative full-day total rather than adding the visible filtered rows", async () => {
  mount();
  await screen.findByRole("button", { name: /View Yogurt/ });
  expect(await screen.findByText("999 kcal · day total")).toBeTruthy();
  expect(screen.getByRole("region", { name: "2026-10-26" })).toBeTruthy();
  expect(api.getDaily).toHaveBeenCalledWith("2026-10-26", expect.anything());
});
it("debounces search for 300ms and starts each new search at the first cursor", async () => {
  mount();
  await screen.findByText("Yogurt");
  const search = screen.getByRole("searchbox");
  fireEvent.change(search, { target: { value: "chi" } });
  fireEvent.change(search, { target: { value: "chicken" } });
  expect(api.getMeals).toHaveBeenCalledTimes(1);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(api.getMeals).toHaveBeenCalledTimes(1);
  await waitFor(() =>
    expect(api.getMeals).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: "chicken", cursor: undefined }),
      expect.anything(),
    ),
  );
});
it("keeps loaded pages after a pagination failure, then retries the same opaque cursor", async () => {
  vi.mocked(api.getMeals)
    .mockResolvedValueOnce({ meals: [first], next_cursor: "opaque-page-2" })
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValueOnce({ meals: [first, second], next_cursor: null });
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Load earlier meals" }),
  );
  await screen.findByText("Earlier meals couldn’t load.");
  expect(screen.getByText("Yogurt")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry earlier meals" }));
  await screen.findByText("Chicken");
  expect(screen.getAllByText("Yogurt")).toHaveLength(1);
  expect(
    vi
      .mocked(api.getMeals)
      .mock.calls.slice(1)
      .map(([query]) => query?.cursor),
  ).toEqual(["opaque-page-2", "opaque-page-2"]);
});
it("applies inclusive date filters and rejects reversed dates without sending them", async () => {
  mount();
  await screen.findByText("Yogurt");
  fireEvent.change(screen.getByLabelText("From date"), {
    target: { value: "2026-10-27" },
  });
  fireEvent.change(screen.getByLabelText("To date"), {
    target: { value: "2026-10-26" },
  });
  fireEvent.submit(
    screen.getByRole("button", { name: "Apply dates" }).closest("form")!,
  );
  expect(screen.getByRole("alert").textContent).toContain("Start date");
  expect(api.getMeals).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText("From date"), {
    target: { value: "2026-10-01" },
  });
  fireEvent.submit(
    screen.getByRole("button", { name: "Apply dates" }).closest("form")!,
  );
  await waitFor(() =>
    expect(api.getMeals).toHaveBeenLastCalledWith(
      expect.objectContaining({
        from: "2026-10-01",
        to: "2026-10-26",
        cursor: undefined,
      }),
      expect.anything(),
    ),
  );
});
it("distinguishes an empty log from no search results and can clear the filters", async () => {
  vi.mocked(api.getMeals).mockResolvedValue({ meals: [], next_cursor: null });
  mount();
  await screen.findByText("Your food log starts here");
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "missing" },
  });
  await screen.findByText("No matching meals");
  fireEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]);
  await screen.findByText("Your food log starts here");
  expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
});
it("retries an initial request failure without losing the filters", async () => {
  vi.mocked(api.getMeals).mockRejectedValueOnce(new Error("Offline"));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Retry history" }));
  await screen.findByText("Yogurt");
});
it("retains native date input events when another field rerenders the form", async () => {
  mount();
  await screen.findByText("Yogurt");
  fireEvent.input(screen.getByLabelText("From date"), {
    target: { value: "2026-10-01" },
  });
  fireEvent.input(screen.getByLabelText("To date"), {
    target: { value: "2026-10-27" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply dates" }));
  await waitFor(() =>
    expect(api.getMeals).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: "2026-10-01", to: "2026-10-27" }),
      expect.anything(),
    ),
  );
  expect((screen.getByLabelText("From date") as HTMLInputElement).value).toBe(
    "2026-10-01",
  );
});
it("does not group or request history until the account time zone is available", async () => {
  vi.mocked(api.getPreferences).mockRejectedValueOnce(new Error("Offline"));
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry time zone" }),
  );
  expect(api.getMeals).not.toHaveBeenCalled();
  await screen.findByText("Yogurt");
});
it("retries a failed day total independently", async () => {
  vi.mocked(api.getDaily).mockRejectedValueOnce(new Error("Offline"));
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry day total" }),
  );
  await screen.findByText("999 kcal · day total");
  expect(api.getMeals).toHaveBeenCalledTimes(1);
});
it("loads another page when the infinite-scroll sentinel becomes visible", async () => {
  let notify!: IntersectionObserverCallback;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        notify = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.mocked(api.getMeals)
    .mockResolvedValueOnce({ meals: [first], next_cursor: "next" })
    .mockResolvedValue({ meals: [second], next_cursor: null });
  mount();
  await screen.findByText("Yogurt");
  await waitFor(() => expect(notify).toBeDefined());
  notify(
    [{ isIntersecting: true } as IntersectionObserverEntry],
    {} as IntersectionObserver,
  );
  await screen.findByText("Chicken");
  expect(
    within(screen.getByRole("region", { name: "2026-10-25" })).getByText(
      "Chicken",
    ),
  ).toBeTruthy();
});
