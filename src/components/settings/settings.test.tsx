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
import { authClient } from "@/lib/api/auth";
import { endAccountSession } from "@/lib/api/account-session";
import { queryKeys } from "@/hooks/use-api";
import { PreferencesSettings } from "./preferences-settings";
import { GoalsSettings } from "./goals-settings";
import { MemoriesSettings } from "./memories-settings";
import { AccountSettings, DataSettings } from "./data-account-settings";
import { GoalCalculator } from "@/components/goals/goal-calculator";

const theme = vi.hoisted(() => vi.fn());
vi.mock("next-themes", () => ({ useTheme: () => ({ setTheme: theme }) }));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof api>()),
  getPreferences: vi.fn(),
  patchPreferences: vi.fn(),
  getGoals: vi.fn(),
  putGoals: vi.fn(),
  suggestGoals: vi.fn(),
  getMemories: vi.fn(),
  patchMemory: vi.fn(),
  deleteMemory: vi.fn(),
  exportData: vi.fn(),
  getMe: vi.fn(),
  deleteAccount: vi.fn(),
}));
vi.mock("@/lib/api/auth", async (original) => ({
  ...(await original<typeof import("@/lib/api/auth")>()),
  authClient: { signOut: vi.fn() },
}));
vi.mock("@/lib/api/account-session", () => ({
  endAccountSession: vi.fn(async (client: QueryClient) => {
    await client.cancelQueries();
    client.clear();
  }),
}));
const preferences = {
  theme: "light" as const,
  save_mode: "confirm" as const,
  timezone: "UTC",
  assistant_style: "casual" as const,
};
const targets = { calories: 2200, protein_g: 150, carbs_g: 250, fat_g: 65 };
const memory = {
  id: "memory-1",
  category: "portion" as const,
  content: "Usual shake",
  created_at: "2026-10-27T12:00:00Z",
  updated_at: "2026-10-27T12:00:00Z",
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getPreferences).mockResolvedValue(preferences);
  vi.mocked(api.patchPreferences).mockImplementation(async (patch) => ({
    ...preferences,
    ...patch,
  }));
  vi.mocked(api.getGoals).mockResolvedValue({
    ...targets,
    effective_from: "2026-10-27",
  });
  vi.mocked(api.putGoals).mockImplementation(async (body) => ({
    ...body,
    effective_from: "2026-10-27",
  }));
  vi.mocked(api.suggestGoals).mockResolvedValue({
    suggested: targets,
    explanation: "Example estimate",
  });
  vi.mocked(api.getMemories).mockResolvedValue({ memories: [memory] });
  vi.mocked(api.patchMemory).mockImplementation(async (_id, patch) => ({
    ...memory,
    ...patch,
  }));
  vi.mocked(api.deleteMemory).mockResolvedValue(undefined);
  vi.mocked(api.getMe).mockResolvedValue({
    user_id: "user",
    email: "test@example.com",
    approved: true,
    onboarding_complete: true,
    display_name: "Test",
  });
  vi.mocked(api.deleteAccount).mockResolvedValue(undefined);
  vi.mocked(authClient.signOut).mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function mount(child: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>{child}</QueryClientProvider>,
  );
  return { client, ...view };
}
it("retains preferences after failure and applies the theme only after save", async () => {
  vi.mocked(api.patchPreferences).mockRejectedValueOnce(new Error("Offline"));
  const { client } = mount(<PreferencesSettings />);
  fireEvent.change(await screen.findByLabelText("Theme"), {
    target: { value: "dark" },
  });
  fireEvent.change(screen.getByLabelText("Save mode"), {
    target: { value: "auto" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Time zone" }), {
    target: { value: "America/Los_Angeles" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
  await screen.findByText("Offline");
  expect((screen.getByLabelText("Theme") as HTMLSelectElement).value).toBe(
    "dark",
  );
  expect(theme).not.toHaveBeenCalledWith("dark");
  fireEvent.click(screen.getByRole("button", { name: "Retry preferences" }));
  await screen.findByText("Preferences saved.");
  expect(client.getQueryData(queryKeys.preferences)).toMatchObject({
    theme: "dark",
    save_mode: "auto",
    timezone: "America/Los_Angeles",
  });
  expect(theme).toHaveBeenCalledWith("dark");
});
it("keeps a preference draft when server preferences refresh", async () => {
  const { client } = mount(<PreferencesSettings />);
  fireEvent.change(await screen.findByLabelText("Theme"), {
    target: { value: "dark" },
  });
  act(() =>
    client.setQueryData(queryKeys.preferences, {
      ...preferences,
      theme: "system",
    }),
  );
  expect((screen.getByLabelText("Theme") as HTMLSelectElement).value).toBe(
    "dark",
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel changes" }));
  expect((screen.getByLabelText("Theme") as HTMLSelectElement).value).toBe(
    "system",
  );
});
it("saves entered targets without overwriting them after a failed save", async () => {
  vi.mocked(api.putGoals).mockRejectedValueOnce(new Error("Goals offline"));
  mount(<GoalsSettings />);
  fireEvent.change(await screen.findByLabelText("Calories (kcal)"), {
    target: { value: "2300" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save goals" }));
  await screen.findByText("Goals offline");
  expect(
    (screen.getByLabelText("Calories (kcal)") as HTMLInputElement).value,
  ).toBe("2300");
  fireEvent.click(screen.getByRole("button", { name: "Retry goals" }));
  await screen.findByText("Goals saved.");
  expect(api.putGoals).toHaveBeenLastCalledWith({ ...targets, calories: 2300 });
});
it("reviews a calculated suggestion without saving targets automatically", async () => {
  mount(<GoalsSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "Recalculate" }));
  fireEvent.change(screen.getByLabelText("Age"), { target: { value: "30" } });
  fireEvent.change(screen.getByLabelText("Height (cm)"), {
    target: { value: "175" },
  });
  fireEvent.change(screen.getByLabelText("Weight"), {
    target: { value: "75" },
  });
  fireEvent.change(screen.getByLabelText("Sex used by the equation"), {
    target: { value: "male" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Calculate targets" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Review these targets" }),
  );
  await screen.findByText(
    "Suggested targets are ready to review. Tap Save goals to apply them.",
  );
  expect(api.putGoals).not.toHaveBeenCalled();
});
it("converts imperial calculator inputs and keeps them for a failed calculation retry", async () => {
  vi.mocked(api.suggestGoals).mockRejectedValueOnce(
    new Error("Calculator offline"),
  );
  mount(<GoalCalculator onChoose={() => {}} />);
  fireEvent.change(screen.getByLabelText("Age"), { target: { value: "30" } });
  fireEvent.change(screen.getByLabelText("Height units"), {
    target: { value: "ft" },
  });
  fireEvent.change(screen.getByLabelText("Weight units"), {
    target: { value: "lb" },
  });
  fireEvent.change(screen.getByLabelText("Height feet"), {
    target: { value: "5" },
  });
  fireEvent.change(screen.getByLabelText("Height inches"), {
    target: { value: "10" },
  });
  fireEvent.change(screen.getByLabelText("Weight"), {
    target: { value: "165" },
  });
  fireEvent.change(screen.getByLabelText("Sex used by the equation"), {
    target: { value: "male" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Calculate targets" }));
  await screen.findByText("Calculator offline");
  fireEvent.click(screen.getByRole("button", { name: "Retry calculation" }));
  await screen.findByText("Example estimate");
  expect(vi.mocked(api.suggestGoals).mock.calls[1][0].height_cm).toBeCloseTo(
    177.8,
  );
  expect(vi.mocked(api.suggestGoals).mock.calls[1][0].weight_kg).toBeCloseTo(
    74.8427,
  );
});
it("edits a memory with retry, then requires explicit confirmation to delete it", async () => {
  vi.mocked(api.patchMemory).mockRejectedValueOnce(new Error("Memory offline"));
  mount(<MemoriesSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit memory" }));
  fireEvent.change(screen.getByLabelText("Memory content"), {
    target: { value: "Updated shake" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save memory" }));
  await screen.findByText("Memory offline");
  fireEvent.click(screen.getByRole("button", { name: "Retry memory" }));
  await screen.findByText("Updated shake");
  fireEvent.click(screen.getByRole("button", { name: "Delete memory" }));
  expect(api.deleteMemory).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm delete memory" }),
  );
  await screen.findByText("No saved memories yet.");
});
it("downloads all three export scopes with temporary URLs and retries an export error", async () => {
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  URL.createObjectURL = vi.fn(() => "blob:export");
  URL.revokeObjectURL = vi.fn();
  vi.mocked(api.exportData)
    .mockRejectedValueOnce(new Error("Export offline"))
    .mockResolvedValue(new Blob(["test"]));
  const view = mount(<DataSettings />);
  fireEvent.click(screen.getByRole("button", { name: "Export Nutrition CSV" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry export" }));
  await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
  fireEvent.click(
    screen.getByRole("button", { name: "Export Nutrition JSON" }),
  );
  await waitFor(() => expect(click).toHaveBeenCalledTimes(2));
  fireEvent.click(
    screen.getByRole("button", { name: "Export Full account JSON" }),
  );
  await waitFor(() => expect(click).toHaveBeenCalledTimes(3));
  expect(api.exportData).toHaveBeenLastCalledWith("json", "account");
  view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:export");
});
it("requires exact DELETE and retains confirmation after a failed account deletion", async () => {
  vi.mocked(api.deleteAccount).mockRejectedValueOnce(
    new Error("Delete offline"),
  );
  mount(<AccountSettings />);
  await screen.findByText("Signed in as test@example.com");
  fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
  fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), {
    target: { value: "delete" },
  });
  expect(
    (
      screen.getByRole("button", {
        name: "Permanently delete account",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(api.deleteAccount).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), {
    target: { value: "DELETE" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Permanently delete account" }),
  );
  await screen.findByText("Delete offline");
  expect(endAccountSession).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Retry account deletion" }),
  );
  await waitFor(() => expect(endAccountSession).toHaveBeenCalledOnce());
});
it("keeps private cache after sign-out failure and clears it only after success", async () => {
  vi.mocked(authClient.signOut).mockRejectedValueOnce(new Error("Network"));
  const { client } = mount(<AccountSettings />);
  client.setQueryData(["private-test"], "private");
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await screen.findByRole("button", { name: "Retry sign out" });
  expect(client.getQueryData(["private-test"])).toBe("private");
  fireEvent.click(screen.getByRole("button", { name: "Retry sign out" }));
  await waitFor(() =>
    expect(client.getQueryData(["private-test"])).toBeUndefined(),
  );
});
it("blocks duplicate account deletion requests while one is pending", async () => {
  let finish!: () => void;
  vi.mocked(api.deleteAccount).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  mount(<AccountSettings />);
  await screen.findByText("Signed in as test@example.com");
  fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
  fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), {
    target: { value: "DELETE" },
  });
  const form = screen
    .getByRole("button", { name: "Permanently delete account" })
    .closest("form")!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  await waitFor(() => expect(api.deleteAccount).toHaveBeenCalledOnce());
  await act(async () => finish());
  await waitFor(() => expect(endAccountSession).toHaveBeenCalledOnce());
});
it("rejects blank goal fields without sending zero-valued targets", async () => {
  mount(<GoalsSettings />);
  fireEvent.change(await screen.findByLabelText("Protein (g)"), {
    target: { value: "" },
  });
  fireEvent.submit(
    screen.getByRole("button", { name: "Save goals" }).closest("form")!,
  );
  await screen.findByText("Enter valid daily targets in all four fields.");
  expect(api.putGoals).not.toHaveBeenCalled();
});
it("retains a memory and its confirmation after a failed deletion", async () => {
  vi.mocked(api.deleteMemory).mockRejectedValueOnce(
    new Error("Memory delete offline"),
  );
  mount(<MemoriesSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "Delete memory" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm delete memory" }),
  );
  await screen.findByText("Memory delete offline");
  expect(screen.getByText("Usual shake")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry delete memory" }));
  await screen.findByText("No saved memories yet.");
});
