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
import { formatInTimeZone } from "date-fns-tz";
import * as api from "@/lib/api";
import { queryKeys } from "@/hooks/use-api";
import { InsightsScreen } from "./insights-screen";
import type { DailySummary, MealListItem, Preferences } from "@/types/api";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof api>()),
  getPreferences: vi.fn(),
  getMeals: vi.fn(),
  getDaily: vi.fn(),
}));
const preferences: Preferences = {
  timezone: "UTC",
  theme: "system",
  save_mode: "confirm",
  assistant_style: "casual",
};
const dates = [
  "2025-10-27",
  "2025-10-21",
  "2025-10-15",
  "2025-10-08",
  "2025-10-01",
  "2025-09-25",
  "2025-09-10",
  "2025-08-01",
];
const meal = (date: string, id = date): MealListItem => ({
  id,
  name: "Saved meal",
  consumed_at: `${date}T12:00:00Z`,
  totals: { calories: 1, protein_g: 1, carbs_g: 0, fat_g: 0 },
});
const summary = (date: string, calories = 1234): DailySummary => ({
  date,
  timezone: "UTC",
  consumed: { calories, protein_g: 87.5, carbs_g: 100, fat_g: 30 },
  targets: null,
  remaining: null,
  meals: [meal(date)],
});
const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <InsightsScreen />
    </QueryClientProvider>,
  );
  return client;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getPreferences).mockResolvedValue(preferences);
  vi.mocked(api.getMeals).mockResolvedValue({
    meals: dates.map((date) => meal(date)),
    next_cursor: null,
  });
  vi.mocked(api.getDaily).mockImplementation(async (date) => summary(date!));
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

it("shows seven recorded dates newest first, skips gaps, and uses full server totals", async () => {
  mount();
  await waitFor(() => expect(screen.getAllByText("1,234")).toHaveLength(7));
  const rows = screen.getAllByRole("row").slice(1);
  expect(rows).toHaveLength(7);
  expect(rows.map((row) => row.querySelector("time")?.dateTime)).toEqual(
    dates.slice(0, 7),
  );
  expect(screen.getAllByText("87.5 g")).toHaveLength(7);
  expect(api.getDaily).toHaveBeenCalledTimes(7);
  expect(api.getDaily).not.toHaveBeenCalledWith(
    "2025-10-26",
    expect.anything(),
  );
  expect(screen.getByText(/Missing days aren’t counted as zero/)).toBeTruthy();
  expect(screen.getByText(/Charts and trends are coming/)).toBeTruthy();
});
it("paginates past a busy day until seven distinct days are discovered", async () => {
  vi.mocked(api.getMeals).mockImplementation(async (filters) =>
    filters?.cursor
      ? {
          meals: [
            meal(dates[0], "duplicate"),
            ...dates.slice(1).map((date) => meal(date)),
          ],
          next_cursor: "unused",
        }
      : {
          meals: Array.from({ length: 100 }, (_, index) =>
            meal(dates[0], String(index)),
          ),
          next_cursor: "older",
        },
  );
  mount();
  await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(8));
  expect(api.getMeals).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.getMeals).mock.calls[1][0]).toEqual({
    to: formatInTimeZone(new Date(), "UTC", "yyyy-MM-dd"),
    limit: 100,
    cursor: "older",
  });
  expect(api.getDaily).toHaveBeenCalledTimes(7);
});
it("keeps loaded days when pagination fails and retries the same cursor", async () => {
  let attempts = 0;
  vi.mocked(api.getMeals).mockImplementation(async (filters) => {
    if (!filters?.cursor)
      return { meals: [meal(dates[0])], next_cursor: "older" };
    if (++attempts === 1) throw new Error("offline");
    return {
      meals: dates.slice(1, 7).map((date) => meal(date)),
      next_cursor: null,
    };
  });
  mount();
  await screen.findByRole("button", { name: "Retry recorded days" });
  expect(screen.getByText("Oct 27, 2025")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry recorded days" }));
  await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(8));
  expect(attempts).toBe(2);
});
it("has a useful empty state without fetching unrecorded calendar days", async () => {
  vi.mocked(api.getMeals).mockResolvedValue({ meals: [], next_cursor: null });
  mount();
  await screen.findByText("Your first day starts with a meal");
  expect(
    screen.getByRole("link", { name: /Log a meal/ }).getAttribute("href"),
  ).toBe("/chat");
  expect(api.getDaily).not.toHaveBeenCalled();
  expect(screen.queryByRole("table")).toBeNull();
});
it("shows fewer than seven days without manufacturing zero days", async () => {
  vi.mocked(api.getMeals).mockResolvedValue({
    meals: [meal(dates[0])],
    next_cursor: null,
  });
  mount();
  await screen.findByText(
    "1 recorded day so far. More will appear as you log meals.",
  );
  expect(screen.getAllByRole("row")).toHaveLength(2);
  expect(api.getDaily).toHaveBeenCalledTimes(1);
});
it("retries a single failed daily summary while keeping other rows", async () => {
  let fail = true;
  vi.mocked(api.getDaily).mockImplementation(async (date) => {
    if (date === dates[1] && fail) {
      fail = false;
      throw new Error("offline");
    }
    return summary(date!);
  });
  mount();
  await screen.findByRole("button", { name: "Retry Oct 21, 2025" });
  expect(screen.getAllByText("1,234")).toHaveLength(6);
  const calls = vi.mocked(api.getDaily).mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Retry Oct 21, 2025" }));
  await waitFor(() => expect(screen.getAllByText("1,234")).toHaveLength(7));
  expect(api.getDaily).toHaveBeenCalledTimes(calls + 1);
});
it("waits for account time zone and retries preferences before discovering days", async () => {
  vi.mocked(api.getPreferences).mockRejectedValueOnce(new Error("offline"));
  mount();
  await screen.findByRole("button", { name: "Retry time zone" });
  expect(api.getMeals).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry time zone" }));
  await screen.findByRole("table");
});
it("groups midnight and DST timestamps in the account zone and refetches when it changes", async () => {
  vi.mocked(api.getMeals).mockResolvedValue({
    meals: [
      { ...meal("2025-11-02", "a"), consumed_at: "2025-11-02T03:30:00Z" },
      { ...meal("2025-11-02", "b"), consumed_at: "2025-11-02T05:30:00Z" },
      { ...meal("2025-11-02", "c"), consumed_at: "2025-11-02T06:30:00Z" },
    ],
    next_cursor: null,
  });
  const client = mount();
  await screen.findByText("Nov 2, 2025");
  act(() =>
    client.setQueryData(queryKeys.preferences, {
      ...preferences,
      timezone: "America/New_York",
    }),
  );
  await screen.findByText("Nov 1, 2025");
  expect(screen.getAllByRole("row")).toHaveLength(3);
  expect(screen.getByText("Dates follow America/New York.")).toBeTruthy();
  expect(api.getMeals).toHaveBeenCalledTimes(2);
});
it("excludes future dates and sends an inclusive today bound", async () => {
  vi.mocked(api.getMeals).mockResolvedValue({
    meals: [meal("2100-01-01"), meal(dates[0])],
    next_cursor: null,
  });
  mount();
  await screen.findByText("Oct 27, 2025");
  expect(screen.queryByText("Jan 1, 2100")).toBeNull();
  expect(vi.mocked(api.getMeals).mock.calls[0][0]?.to).toBe(
    formatInTimeZone(new Date(), "UTC", "yyyy-MM-dd"),
  );
});
it("updates from the shared daily cache without summing meals or fetching totals again", async () => {
  const client = mount();
  await waitFor(() => expect(screen.getAllByText("1,234")).toHaveLength(7));
  const calls = vi.mocked(api.getDaily).mock.calls.length;
  act(() =>
    client.setQueryData(queryKeys.daily(dates[0]), summary(dates[0], 999)),
  );
  await waitFor(() =>
    expect(within(screen.getAllByRole("row")[1]).getByText("999")).toBeTruthy(),
  );
  expect(api.getDaily).toHaveBeenCalledTimes(calls);
});
it("keeps actual zero totals on a recorded day", async () => {
  vi.mocked(api.getMeals).mockResolvedValue({
    meals: [meal(dates[0])],
    next_cursor: null,
  });
  vi.mocked(api.getDaily).mockResolvedValue({
    ...summary(dates[0], 0),
    consumed: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
  });
  mount();
  await screen.findByText("0 g");
  expect(screen.getByText("0")).toBeTruthy();
});
it("shows cached totals and refresh after a background daily request fails", async () => {
  const client = mount();
  await waitFor(() => expect(screen.getAllByText("1,234")).toHaveLength(7));
  vi.mocked(api.getDaily).mockRejectedValueOnce(new Error("offline"));
  await act(async () => {
    await client.refetchQueries({ queryKey: queryKeys.daily(dates[0]) });
  });
  expect(screen.getAllByText("1,234")).toHaveLength(7);
  fireEvent.click(
    await screen.findByRole("button", { name: "Refresh Oct 27, 2025" }),
  );
  await waitFor(() =>
    expect(client.getQueryState(queryKeys.daily(dates[0]))?.status).toBe(
      "success",
    ),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Refresh Oct 27, 2025" }),
    ).toBeNull(),
  );
});
