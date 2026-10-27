// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtures } from "@/mocks/fixtures";
import { MealCard } from "./meal-card";
import type { NutritionSource } from "@/types/api";

afterEach(cleanup);
const fixture = () => createFixtures(new Date("2026-10-26T12:30:00Z"));
it("expands photo portions, assumptions, uncertainty, time and totals accessibly", () => {
  const f = fixture();
  render(
    <MealCard
      card={{ kind: "proposal", state: "unsaved", proposal: f.photo }}
      timezone="America/Los_Angeles"
    />,
  );
  expect(screen.getByText("Estimated")).toBeTruthy();
  expect(screen.queryByText("Cooking oil")).toBeNull();
  const expand = screen.getByRole("button", { name: "Expand Photo meal" });
  fireEvent.click(expand);
  expect(expand.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("Cooking oil")).toBeTruthy();
  expect(screen.getByText("Assumed")).toBeTruthy();
  expect(screen.getByText("Portion uncertain")).toBeTruthy();
  expect(
    screen.getByText("Assumed one teaspoon of oil; adjust if needed."),
  ).toBeTruthy();
  expect(screen.getByText(/Oct 26, 2026/).textContent).toContain("5:30 AM");
  expect(screen.getByText("Total · 365 kcal")).toBeTruthy();
  expect(
    screen
      .getByRole("link", { name: /USDA source for Cooking oil/ })
      .getAttribute("rel"),
  ).toContain("noopener");
  fireEvent.click(expand);
  expect(screen.queryByText("Cooking oil")).toBeNull();
});
it.each<[NutritionSource, string]>([
  ["usda", "USDA"],
  ["open_food_facts", "Open Food Facts"],
  ["label", "Label"],
  ["web", "Web"],
  ["ai", "AI estimate"],
  ["manual", "Manual"],
])(
  "renders the %s source without turning non-URLs into links",
  (source, label) => {
    const f = fixture();
    f.single.items[0].nutrition_source = source;
    f.single.items[0].source_reference = "12345";
    render(
      <MealCard
        card={{ kind: "proposal", state: "unsaved", proposal: f.single }}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Expand Eggs and toast" }),
    );
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(!!screen.queryByText("Estimated")).toBe(source === "ai");
  },
);
it.each(["javascript:alert(1)", "data:text/html,hello", "/relative-source"])(
  "does not link unsafe or relative source references: %s",
  (reference) => {
    const f = fixture();
    f.single.items[0].source_reference = reference;
    render(
      <MealCard
        card={{ kind: "proposal", state: "unsaved", proposal: f.single }}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Expand Eggs and toast" }),
    );
    expect(screen.queryByRole("link")).toBeNull();
  },
);
it("renders saved, discarded and deleted states without unsaved actions", () => {
  const f = fixture();
  const view = render(
    <MealCard
      card={{ kind: "meal", meal_id: f.autoSaved.id, meal: f.autoSaved }}
    />,
  );
  expect(screen.getByText("Saved")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  view.rerender(
    <MealCard
      card={{ kind: "proposal", state: "discarded", proposal: f.single }}
    />,
  );
  expect(screen.getByText("Discarded · Eggs and toast")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
  view.rerender(
    <MealCard card={{ kind: "meal", meal_id: f.autoSaved.id, meal: null }} />,
  );
  expect(screen.getByText("This meal was deleted.")).toBeTruthy();
});
it("asks for clarification before allowing a save and calls the composer focus action", () => {
  const f = fixture();
  const clarify = vi.fn();
  const save = vi.fn();
  render(
    <MealCard
      card={{ kind: "proposal", state: "unsaved", proposal: f.clarification }}
      onClarify={clarify}
      onSave={save}
    />,
  );
  expect(
    (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: /Was that one serving or two/ }),
  );
  expect(clarify).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
});
