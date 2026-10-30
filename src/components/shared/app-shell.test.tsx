// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppShell } from "./app-shell";

const route = vi.hoisted(() => ({ pathname: "/chat" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));
afterEach(cleanup);

it("moves focus to main after an app route change", () => {
  route.pathname = "/chat";
  const view = render(
    <AppShell>
      <h1>Chat</h1>
    </AppShell>,
  );
  route.pathname = "/history";
  view.rerender(
    <AppShell>
      <h1>History</h1>
    </AppShell>,
  );
  expect(document.activeElement).toBe(screen.getByRole("main"));
});

it.each(["chat", "history", "insights", "settings"])(
  "marks only %s current in each navigation",
  (page) => {
    route.pathname = `/${page}`;
    render(
      <AppShell>
        <h1>Page content</h1>
      </AppShell>,
    );
    for (const navigation of screen.getAllByRole("navigation", {
      name: "Primary navigation",
    })) {
      const links = within(navigation).getAllByRole("link");
      expect(links.map((link) => link.getAttribute("href"))).toEqual([
        "/chat",
        "/history",
        "/insights",
        "/settings",
      ]);
      const current = within(navigation).getByRole("link", { current: "page" });
      expect(current.getAttribute("href")).toBe(`/${page}`);
      expect(
        links.filter((link) => link.hasAttribute("aria-current")),
      ).toHaveLength(1);
    }
  },
);

it("keeps child routes selected and supplies a keyboard skip target", () => {
  route.pathname = "/history/meal-123";
  render(
    <AppShell>
      <h1>Meal details</h1>
    </AppShell>,
  );
  expect(
    screen
      .getAllByRole("link", { current: "page" })
      .every((link) => link.textContent === "History"),
  ).toBe(true);
  const main = screen.getByRole("main");
  expect(main.textContent).toBe("Meal details");
  expect(main.getAttribute("tabindex")).toBe("-1");
  expect(
    screen.getByRole("link", { name: "Skip to content" }).getAttribute("href"),
  ).toBe(`#${main.id}`);
});
