// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { queryKeys } from "@/hooks/use-api";
import { OnboardingScreen } from "./onboarding-screen";
import { OnboardingGate } from "./onboarding-gate";

const nav = vi.hoisted(() => ({ replace: vi.fn(), path: "/chat" }));
vi.mock("next/navigation", () => ({
  useRouter: () => nav,
  usePathname: () => nav.path,
}));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof api>()),
  getMe: vi.fn(),
  getPreferences: vi.fn(),
  getGoals: vi.fn(),
  patchPreferences: vi.fn(),
  putGoals: vi.fn(),
  suggestGoals: vi.fn(),
  completeOnboarding: vi.fn(),
}));
const prefs = {
  theme: "system" as const,
  save_mode: "confirm" as const,
  timezone: "UTC",
  assistant_style: "casual" as const,
};
const me = {
  user_id: "ken",
  email: "ken@example.test",
  display_name: "Ken",
  approved: true,
  onboarding_complete: false,
};
const targets = { calories: 2200, protein_g: 150, carbs_g: 250, fat_g: 65 };
const clients: QueryClient[] = [];
function mount(component = <OnboardingScreen />) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 60_000 },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>{component}</QueryClientProvider>,
  );
  return client;
}
const click = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));
const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
async function calculator() {
  await screen.findByRole("button", { name: "Save time zone & continue" });
  click("Save time zone & continue");
  await screen.findByRole("heading", { name: "Goal calculator" });
}
async function ownTargets() {
  await calculator();
  click("Skip calculator");
}
async function saveMode() {
  await ownTargets();
  click("Skip targets");
}
beforeEach(() => {
  vi.resetAllMocks();
  nav.path = "/chat";
  vi.mocked(api.getMe).mockResolvedValue(me);
  vi.mocked(api.getPreferences).mockResolvedValue(prefs);
  vi.mocked(api.getGoals).mockResolvedValue(null);
  vi.mocked(api.patchPreferences).mockImplementation(async (patch) => ({
    ...prefs,
    ...patch,
  }));
  vi.mocked(api.putGoals).mockImplementation(async (body) => ({
    ...body,
    effective_from: "2026-10-27",
  }));
  vi.mocked(api.suggestGoals).mockResolvedValue({
    suggested: targets,
    explanation: "Example calculation",
  });
  vi.mocked(api.completeOnboarding).mockResolvedValue({
    ...me,
    onboarding_complete: true,
  });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

it("saves the detected time zone before advancing and keeps the selection after failure", async () => {
  vi.mocked(api.patchPreferences).mockRejectedValueOnce(new Error("offline"));
  mount();
  await screen.findByLabelText("Time zone");
  expect((screen.getByLabelText("Time zone") as HTMLSelectElement).value).toBe(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  change("Time zone", "America/Los_Angeles");
  click("Save time zone & continue");
  await screen.findByRole("alert");
  expect((screen.getByLabelText("Time zone") as HTMLSelectElement).value).toBe(
    "America/Los_Angeles",
  );
  expect(api.completeOnboarding).not.toHaveBeenCalled();
  click("Save time zone & continue");
  await screen.findByRole("heading", { name: "Goal calculator" });
  expect(api.patchPreferences).toHaveBeenLastCalledWith({
    timezone: "America/Los_Angeles",
  });
  expect(document.activeElement?.textContent).toBe("Goal calculator");
});
it("skips optional stats and targets, saves the selected mode, completes and navigates", async () => {
  const client = mount();
  await saveMode();
  fireEvent.click(screen.getByRole("radio", { name: /Auto-save/ }));
  click("Finish setup");
  await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/chat"));
  expect(api.suggestGoals).not.toHaveBeenCalled();
  expect(api.putGoals).not.toHaveBeenCalled();
  expect(api.patchPreferences).toHaveBeenLastCalledWith({ save_mode: "auto" });
  expect(client.getQueryData(queryKeys.me)).toEqual({
    ...me,
    onboarding_complete: true,
  });
  expect(
    vi.mocked(api.patchPreferences).mock.invocationCallOrder.at(-1),
  ).toBeLessThan(vi.mocked(api.completeOnboarding).mock.invocationCallOrder[0]);
});
it("reviews a suggestion without saving, allows edits, and keeps stats on Back", async () => {
  mount();
  await calculator();
  change("Age", "30");
  change("Height (cm)", "175");
  change("Weight", "75");
  change("Sex used by the equation", "male");
  click("Calculate targets");
  await screen.findByRole("button", { name: "Review these targets" });
  click("Review these targets");
  expect(api.putGoals).not.toHaveBeenCalled();
  expect(
    (screen.getByLabelText("Calories (kcal)") as HTMLInputElement).value,
  ).toBe("2200");
  click("Back");
  expect((screen.getByLabelText("Age") as HTMLInputElement).value).toBe("30");
  click("Review these targets");
  change("Calories (kcal)", "2300");
  click("Save targets & continue");
  await screen.findByRole("heading", { name: "Save mode" });
  expect(api.putGoals).toHaveBeenCalledWith({ ...targets, calories: 2300 });
});
it("retains manual target edits on failed save and retries without completing early", async () => {
  vi.mocked(api.putGoals).mockRejectedValueOnce(new Error("offline"));
  mount();
  await ownTargets();
  for (const [label, value] of [
    ["Calories (kcal)", "2100"],
    ["Protein (g)", "140"],
    ["Carbs (g)", "240"],
    ["Fat (g)", "65"],
  ])
    change(label, value);
  click("Save targets & continue");
  await screen.findByRole("alert");
  expect(
    (screen.getByLabelText("Calories (kcal)") as HTMLInputElement).value,
  ).toBe("2100");
  expect(api.completeOnboarding).not.toHaveBeenCalled();
  click("Save targets & continue");
  await screen.findByRole("heading", { name: "Save mode" });
});
it("does not call completion if the mode save fails; retains the choice for retry", async () => {
  mount();
  await saveMode();
  vi.mocked(api.patchPreferences).mockRejectedValueOnce(new Error("offline"));
  fireEvent.click(screen.getByRole("radio", { name: /Auto-save/ }));
  click("Finish setup");
  await screen.findByRole("alert");
  expect(api.completeOnboarding).not.toHaveBeenCalled();
  expect(
    (screen.getByRole("radio", { name: /Auto-save/ }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  click("Finish setup");
  await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/chat"));
});
it("retries completion without rewriting an already saved mode", async () => {
  vi.mocked(api.completeOnboarding).mockRejectedValueOnce(new Error("offline"));
  mount();
  await saveMode();
  click("Finish setup");
  await screen.findByRole("alert");
  expect(nav.replace).not.toHaveBeenCalled();
  click("Finish setup");
  await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/chat"));
  expect(api.completeOnboarding).toHaveBeenCalledTimes(2);
  expect(api.patchPreferences).toHaveBeenCalledTimes(2); // time zone + mode
});
it("blocks duplicate finish requests while completion is pending", async () => {
  let resolve!: (
    value: Awaited<ReturnType<typeof api.completeOnboarding>>,
  ) => void;
  vi.mocked(api.completeOnboarding).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  mount();
  await saveMode();
  click("Finish setup");
  await waitFor(() => expect(api.completeOnboarding).toHaveBeenCalledTimes(1));
  click("Finishing setup…");
  expect(api.completeOnboarding).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ ...me, onboarding_complete: true }));
  await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/chat"));
});
it("retries initial setup loading", async () => {
  vi.mocked(api.getGoals).mockRejectedValueOnce(new Error("offline"));
  mount();
  await screen.findByRole("button", { name: "Retry setup" });
  click("Retry setup");
  await screen.findByRole("button", { name: "Save time zone & continue" });
});
it("preserves existing targets when they are skipped", async () => {
  vi.mocked(api.getGoals).mockResolvedValue({
    ...targets,
    effective_from: "2026-10-27",
  });
  mount();
  await ownTargets();
  expect(
    (screen.getByLabelText("Calories (kcal)") as HTMLInputElement).value,
  ).toBe("2200");
  click("Skip targets");
  click("Back");
  expect(
    (screen.getByLabelText("Calories (kcal)") as HTMLInputElement).value,
  ).toBe("2200");
  expect(api.putGoals).not.toHaveBeenCalled();
});
it("gates incomplete accounts before rendering app content", async () => {
  mount(
    <OnboardingGate>
      <p>Private chat</p>
    </OnboardingGate>,
  );
  await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/onboarding"));
  expect(screen.queryByText("Private chat")).toBeNull();
});
it("allows incomplete accounts on onboarding and redirects completed accounts to chat", async () => {
  nav.path = "/onboarding";
  const client = mount(
    <OnboardingGate>
      <p>Setup content</p>
    </OnboardingGate>,
  );
  await screen.findByText("Setup content");
  expect(nav.replace).not.toHaveBeenCalled();
  act(() =>
    client.setQueryData(queryKeys.me, { ...me, onboarding_complete: true }),
  );
  await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/chat"));
});
it("allows completed accounts through and offers retry when me fails", async () => {
  vi.mocked(api.getMe).mockRejectedValueOnce(new Error("offline"));
  vi.mocked(api.getMe).mockResolvedValueOnce({
    ...me,
    onboarding_complete: true,
  });
  mount(
    <OnboardingGate>
      <p>Private chat</p>
    </OnboardingGate>,
  );
  await screen.findByRole("button", { name: "Retry account" });
  click("Retry account");
  await screen.findByText("Private chat");
  expect(nav.replace).not.toHaveBeenCalled();
});
