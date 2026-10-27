// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { ManualLog } from "./manual-log";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof api>()),
  saveMeals: vi.fn(),
}));
afterEach(cleanup);
it("retains manual fields and the save idempotency key on retry", async () => {
  const client = new QueryClient();
  const close = vi.fn();
  vi.mocked(api.saveMeals)
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValueOnce({
      meals: [],
      daily_summary: {
        date: "2026-10-26",
        timezone: "UTC",
        consumed: { calories: 160, protein_g: 15, carbs_g: 12, fat_g: 6 },
        targets: null,
        remaining: null,
        meals: [],
      },
    });
  render(
    <QueryClientProvider client={client}>
      <ManualLog open onOpenChange={close} />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText("Meal name"), {
    target: { value: "Yogurt" },
  });
  for (const [name, value] of [
    ["Calories (kcal)", "160"],
    ["Protein (g)", "15"],
    ["Carbs (g)", "12"],
    ["Fat (g)", "6"],
  ])
    fireEvent.change(screen.getByLabelText(name), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Save meal" }));
  await screen.findByText("Offline");
  expect((screen.getByLabelText("Meal name") as HTMLInputElement).value).toBe(
    "Yogurt",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  const calls = vi.mocked(api.saveMeals).mock.calls;
  expect(calls[1][0]).toBe(calls[0][0]);
  expect(calls[0][0].body.meals[0].source_type).toBe("manual");
  expect(calls[0][0].body.meals[0].items[0].macros.calories).toBe(160);
  client.clear();
});
