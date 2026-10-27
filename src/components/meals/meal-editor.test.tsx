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
import { createFixtures } from "@/mocks/fixtures";
import { MealEditor, type EditorTarget } from "./meal-editor";
import { queryKeys } from "@/hooks/use-api";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof api>()),
  saveMeals: vi.fn(),
  updateMeal: vi.fn(),
  getMeal: vi.fn(),
}));
const f = createFixtures(new Date("2026-10-26T12:30:00Z"));
const daily = {
  date: "2026-10-26",
  timezone: "UTC",
  consumed: { calories: 999, protein_g: 20, carbs_g: 30, fat_g: 14 },
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
  vi.mocked(api.saveMeals).mockResolvedValue({
    meals: [{ ...f.autoSaved, totals: daily.consumed }],
    daily_summary: daily,
  });
  vi.mocked(api.updateMeal).mockResolvedValue({
    meal: { ...f.autoSaved, version: 2 },
    daily_summaries: [daily],
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount(
  target: EditorTarget = {
    kind: "proposal",
    proposal: f.single,
    sourceType: "text",
  },
  initialItem?: number,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const saved = vi.fn();
  const close = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <MealEditor
        target={target}
        initialItem={initialItem}
        onSaved={saved}
        onClose={close}
      />
    </QueryClientProvider>,
  );
  return { client, saved, close };
}
it("updates the preview immediately from grams, saves the edited proposal, and accepts server totals", async () => {
  const { saved, close, client } = mount();
  fireEvent.change(screen.getByLabelText("Item 1 grams"), {
    target: { value: "320" },
  });
  expect(
    within(screen.getByLabelText("Nutrition preview")).getByText("640"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save meal" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  const action = vi.mocked(api.saveMeals).mock.calls[0][0];
  expect(action.idempotencyKey).toBe(f.single.proposal_id);
  expect(action.body.meals[0].items[0].macros.calories).toBe(640);
  expect(action.body.meals[0].items[0]).not.toHaveProperty("id");
  expect(saved).toHaveBeenCalledWith(
    expect.objectContaining({ totals: daily.consumed }),
  );
  expect(client.getQueryData(queryKeys.daily(daily.date))).toEqual(daily);
});
it("keeps a failed edited request and retries the exact save action without losing fields", async () => {
  vi.mocked(api.saveMeals).mockRejectedValueOnce(new Error("Offline"));
  mount();
  fireEvent.change(screen.getByLabelText("Meal name"), {
    target: { value: "Breakfast" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save meal" }));
  await screen.findByRole("button", { name: "Retry save" });
  expect((screen.getByLabelText("Meal name") as HTMLInputElement).value).toBe(
    "Breakfast",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  await waitFor(() => expect(api.saveMeals).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.saveMeals).mock.calls[1][0]).toEqual(
    vi.mocked(api.saveMeals).mock.calls[0][0],
  );
});
it("switches an existing item to manual macros and removes its database basis", async () => {
  mount();
  fireEvent.click(screen.getByRole("checkbox", { name: /Manual macros/ }));
  fireEvent.change(screen.getByLabelText("Item 1 Calories (kcal)"), {
    target: { value: "111" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save meal" }));
  await waitFor(() => expect(api.saveMeals).toHaveBeenCalledOnce());
  expect(
    vi.mocked(api.saveMeals).mock.calls[0][0].body.meals[0].items[0],
  ).toMatchObject({
    nutrition_source: "manual",
    basis_per_100g: null,
    macros: { calories: 111 },
  });
});
it("adds and removes items without allowing an empty meal", async () => {
  mount();
  expect(
    (screen.getByRole("button", { name: "Remove item 1" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Add food item" }));
  fireEvent.change(screen.getByLabelText("Item 2 food name"), {
    target: { value: "Yogurt" },
  });
  for (const [label, value] of [
    ["Calories (kcal)", "160"],
    ["Protein (g)", "15"],
    ["Carbs (g)", "12"],
    ["Fat (g)", "6"],
  ])
    fireEvent.change(screen.getByLabelText(`Item 2 ${label}`), {
      target: { value },
    });
  expect(
    within(screen.getByLabelText("Nutrition preview")).getByText("480"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove item 1" }));
  expect(
    within(screen.getByLabelText("Nutrition preview")).getByText("160"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save meal" }));
  await waitFor(() => expect(api.saveMeals).toHaveBeenCalledOnce());
  expect(
    vi.mocked(api.saveMeals).mock.calls[0][0].body.meals[0].items,
  ).toHaveLength(1);
});
it("refetches on version conflict and requires explicit review before saving with the new version", async () => {
  vi.mocked(api.updateMeal).mockRejectedValueOnce(
    new api.ApiClientError("version_conflict", "Changed", false, 409),
  );
  vi.mocked(api.getMeal).mockResolvedValue({
    ...f.autoSaved,
    name: "Changed elsewhere",
    version: 3,
  });
  const { saved } = mount({ kind: "meal", meal: f.autoSaved });
  fireEvent.change(screen.getByLabelText("Meal name"), {
    target: { value: "My unsaved name" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByRole("button", { name: "Load latest meal" });
  expect(
    screen.getByText("This meal changed — review and save again."),
  ).toBeTruthy();
  expect((screen.getByLabelText("Meal name") as HTMLInputElement).value).toBe(
    "My unsaved name",
  );
  expect(api.updateMeal).toHaveBeenCalledTimes(1);
  expect(saved).not.toHaveBeenCalled();
  expect(
    (screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Load latest meal" }));
  expect((screen.getByLabelText("Meal name") as HTMLInputElement).value).toBe(
    "Changed elsewhere",
  );
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(api.updateMeal).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.updateMeal).mock.calls[0][1].version).toBe(1);
  expect(vi.mocked(api.updateMeal).mock.calls[1][1].version).toBe(3);
});
it("offers a retry when loading the conflict's latest version fails", async () => {
  vi.mocked(api.updateMeal).mockRejectedValueOnce(
    new api.ApiClientError("version_conflict", "Changed", false, 409),
  );
  vi.mocked(api.getMeal)
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValueOnce({ ...f.autoSaved, version: 4 });
  mount({ kind: "meal", meal: f.autoSaved });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByRole("button", { name: "Retry loading latest" });
  fireEvent.click(screen.getByRole("button", { name: "Retry loading latest" }));
  await screen.findByRole("button", { name: "Load latest meal" });
  expect(api.getMeal).toHaveBeenCalledTimes(2);
  expect(api.updateMeal).toHaveBeenCalledTimes(1);
});
it("requires confirmation for a clarification proposal and keeps cancel free of writes", async () => {
  const { close } = mount({
    kind: "proposal",
    proposal: f.clarification,
    sourceType: "text",
  });
  fireEvent.click(screen.getByRole("button", { name: "Save meal" }));
  await screen.findByText("Confirm the portions before saving this proposal.");
  expect(api.saveMeals).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalledOnce();
});

it("preserves saved item IDs and applies both returned date summaries when a meal moves", async () => {
  const otherDay = {
    ...daily,
    date: "2026-10-25",
    consumed: { ...daily.consumed, calories: 640 },
  };
  vi.mocked(api.updateMeal).mockResolvedValue({
    meal: { ...f.autoSaved, version: 2 },
    daily_summaries: [daily, otherDay],
  });
  const { client } = mount({ kind: "meal", meal: f.autoSaved });
  fireEvent.change(screen.getByLabelText("Consumed at"), {
    target: { value: "2026-10-25T09:00" },
  });
  fireEvent.change(screen.getByLabelText("Item 1 grams"), {
    target: { value: "320" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(api.updateMeal).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(client.getQueryData(queryKeys.daily(otherDay.date))).toEqual(
      otherDay,
    ),
  );
  expect(client.getQueryData(queryKeys.daily(daily.date))).toEqual(daily);
  const request = vi.mocked(api.updateMeal).mock.calls[0][1];
  expect(request.items?.[0].id).toBe(f.autoSaved.items[0].id);
  expect(request.items?.[0].macros.calories).toBe(640);
});
