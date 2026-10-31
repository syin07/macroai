// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import type { DailySummary } from "@/types/api";
import { TodayScreen } from "./today-screen";
import { fraction } from "./macro-pie";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof api>()),
  getDaily: vi.fn(),
}));

const summary: DailySummary = {
  date: "2026-10-31",
  timezone: "America/Los_Angeles",
  consumed: { calories: 1420, protein_g: 96, carbs_g: 150, fat_g: 80 },
  targets: { calories: 2000, protein_g: 150, carbs_g: 250, fat_g: 65 },
  remaining: { calories: 580, protein_g: 54, carbs_g: 100, fat_g: -15 },
  meals: [
    {
      id: "meal",
      name: "Lunch",
      consumed_at: "2026-10-31T19:00:00Z",
      totals: { calories: 1420, protein_g: 96, carbs_g: 150, fat_g: 80 },
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getDaily).mockResolvedValue(summary);
});
afterEach(cleanup);

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TodayScreen />
    </QueryClientProvider>,
  );
  return client;
}

function wedge(key: string) {
  const node = document.querySelector(`[data-wedge="${key}"]`);
  if (!node) throw new Error(`no wedge ${key}`);
  return node;
}

it("fills each wedge by its share of the goal and marks over-target wedges", async () => {
  mount();
  const chart = await screen.findByRole("img", { name: /Today's progress toward each goal/ });
  expect(chart.getAttribute("aria-label")).toContain("Calories 1,420 of 2,000 kcal, 71%");
  expect(chart.getAttribute("aria-label")).toContain("Fat 80 of 65 g, 123%, 15 g over");
  expect(wedge("calories").getAttribute("data-percent")).toBe("71");
  expect(wedge("protein_g").getAttribute("data-percent")).toBe("64");
  expect(wedge("carbs_g").getAttribute("data-percent")).toBe("60");
  expect(wedge("fat_g").getAttribute("data-percent")).toBe("123");
  expect(wedge("fat_g").querySelector("[data-overflow]")).not.toBeNull();
  expect(wedge("calories").querySelector("[data-overflow]")).toBeNull();
  // Over-target fill is capped at the full wedge: same geometry as a 100% fill.
  const full = wedge("fat_g").querySelector("[data-fill]")!.getAttribute("d")!;
  expect(full).toContain("A 96 96");
  expect(screen.getByText("Saturday, Oct 31")).toBeTruthy();
  expect(screen.getByText("15 g over")).toBeTruthy();
  expect(screen.getByText("580 kcal")).toBeTruthy();
  expect(screen.queryByText("Nothing logged yet.")).toBeNull();
});

it("scales fill by area, not radius", () => {
  expect(fraction(50, 100)).toBe(0.5);
  expect(fraction(0, 0)).toBe(0);
  expect(fraction(10, 0)).toBe(1);
});

it("shows empty wedges and a logging prompt on an empty day", async () => {
  vi.mocked(api.getDaily).mockResolvedValue({
    ...summary,
    consumed: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
    remaining: summary.targets,
    meals: [],
  });
  mount();
  await screen.findByRole("img", { name: /Today's progress/ });
  expect(document.querySelectorAll("[data-fill]")).toHaveLength(0);
  expect(screen.getByText("Nothing logged yet.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Log your first meal" }).getAttribute("href")).toBe("/chat");
});

it("asks for goals instead of drawing a chart when none are set", async () => {
  vi.mocked(api.getDaily).mockResolvedValue({ ...summary, targets: null, remaining: null });
  mount();
  expect(await screen.findByText("Set your goals to see progress")).toBeTruthy();
  expect(screen.queryByRole("img", { name: /Today's progress/ })).toBeNull();
  expect(screen.getByRole("link", { name: /Set goals/ }).getAttribute("href")).toBe("/settings");
  expect(screen.getByText("1,420 kcal")).toBeTruthy();
  expect(screen.queryByText("Goal")).toBeNull();
});

it("offers a retry when today's summary fails to load", async () => {
  vi.mocked(api.getDaily).mockRejectedValueOnce(new Error("down"));
  mount();
  const retry = await screen.findByRole("button", { name: "Retry" });
  fireEvent.click(retry);
  await waitFor(() => expect(api.getDaily).toHaveBeenCalledTimes(2));
  expect(await screen.findByRole("img", { name: /Today's progress/ })).toBeTruthy();
});
