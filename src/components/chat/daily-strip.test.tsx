// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import type { DailySummary } from "@/types/api";
import { DailyStrip } from "./daily-strip";
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof api>()),
  getDaily: vi.fn(),
  getMeal: vi.fn(),
}));
vi.mock("@/components/meals/meal-editor", () => ({
  MealEditor: ({ target }: { target: { meal: { name: string } } }) => (
    <div role="dialog">Editing {target.meal.name}</div>
  ),
}));
const summary: DailySummary = {
  date: "2026-10-26",
  timezone: "America/Los_Angeles",
  consumed: { calories: 2320, protein_g: 120, carbs_g: 200, fat_g: 80 },
  targets: { calories: 2200, protein_g: 100, carbs_g: 250, fat_g: 70 },
  remaining: { calories: -120, protein_g: -20, carbs_g: 50, fat_g: -10 },
  meals: [
    {
      id: "meal",
      name: "Lunch",
      consumed_at: "2026-10-26T19:00:00Z",
      totals: { calories: 320, protein_g: 20, carbs_g: 30, fat_g: 14 },
    },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getDaily).mockResolvedValue(summary);
});
afterEach(cleanup);
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <DailyStrip />
    </QueryClientProvider>,
  );
  return client;
}
it("shows neutral over-target copy, bounded progress, and a timezone-aware editable timeline", async () => {
  vi.mocked(api.getMeal).mockResolvedValue({
    ...summary.meals[0],
    status: "active",
  } as Awaited<ReturnType<typeof api.getMeal>>);
  mount();
  fireEvent.click(await screen.findByText("Details ↕"));
  expect(screen.getByText("120 kcal over")).toBeTruthy();
  expect(screen.getByText("120 / 100 g · 20 g over")).toBeTruthy();
  expect(
    screen
      .getByRole("progressbar", { name: "Protein" })
      .getAttribute("aria-valuenow"),
  ).toBe("100");
  expect(screen.getByText("12:00 PM")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edit Lunch" }));
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(api.getMeal).toHaveBeenCalledWith("meal", expect.anything());
});
it("shows consumed values and Set goals without targets or percentage bars", async () => {
  vi.mocked(api.getDaily).mockResolvedValue({
    ...summary,
    targets: null,
    remaining: null,
    meals: [],
  });
  mount();
  fireEvent.click(await screen.findByText("Details ↕"));
  expect(
    screen.getByRole("link", { name: "Set goals" }).getAttribute("href"),
  ).toBe("/settings");
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getByText("No meals logged today.")).toBeTruthy();
});
it("handles zero targets without infinite percentages", async () => {
  vi.mocked(api.getDaily).mockResolvedValue({
    ...summary,
    targets: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
    remaining: { calories: -2320, protein_g: -120, carbs_g: -200, fat_g: -80 },
  });
  mount();
  fireEvent.click(await screen.findByText("Details ↕"));
  for (const bar of screen.getAllByRole("progressbar"))
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
  expect(screen.getByText("2,320 kcal over")).toBeTruthy();
});
it("retries a failed summary request", async () => {
  vi.mocked(api.getDaily).mockRejectedValueOnce(new Error("Offline"));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Retry totals" }));
  expect(await screen.findByText("Details ↕")).toBeTruthy();
});
