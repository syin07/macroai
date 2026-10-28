// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authClient, AuthUiError } from "@/lib/api/auth";
import { SignInForm } from "./sign-in-form";
import { SignUpForm } from "./sign-up-form";
import { RequestPasswordReset, SetNewPassword } from "./password-reset";
import { NotApproved } from "./not-approved";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/api/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/auth")>()),
  authClient: {
    signInWithGoogle: vi.fn(),
    signInWithPassword: vi.fn(),
    signUp: vi.fn(),
    sendPasswordReset: vi.fn(),
    updatePassword: vi.fn(),
    signOut: vi.fn(),
    getSession: vi.fn(),
  },
}));

const clients: QueryClient[] = [];
function show(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  return client;
}
function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label, { exact: true }), {
    target: { value },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_USE_MOCKS", "1");
  vi.mocked(authClient.getSession).mockResolvedValue({
    email: "ken@example.com",
    approved: true,
    recovery: false,
  });
  vi.mocked(authClient.signInWithPassword).mockResolvedValue(undefined);
  vi.mocked(authClient.signInWithGoogle).mockResolvedValue(undefined);
  vi.mocked(authClient.signUp).mockResolvedValue(undefined);
  vi.mocked(authClient.sendPasswordReset).mockResolvedValue(undefined);
  vi.mocked(authClient.updatePassword).mockResolvedValue(undefined);
  vi.mocked(authClient.signOut).mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("auth form flows", () => {
  it("enables production sign-in and keeps the preview-only banner out of it", async () => {
    vi.stubEnv("NODE_ENV", "production");
    show(<SignInForm />);
    const button = screen.getByRole("button", { name: "Sign in" });
    expect(button.matches(":disabled")).toBe(false);
    expect(screen.queryByText(/Preview only/)).toBeNull();
    fill("Email", "ken@example.com");
    fill("Password", "test-only-password");
    fireEvent.click(button);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat"));
  });
  it("validates inputs before calling auth and labels invalid fields", async () => {
    show(<SignInForm />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("Enter a valid email address.");
    expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe(
      "current-password",
    );
    expect(authClient.signInWithPassword).not.toHaveBeenCalled();
  });

  it("retains inputs after wrong-password errors and clears them on success", async () => {
    vi.mocked(authClient.signInWithPassword).mockRejectedValueOnce(
      new AuthUiError(
        "invalid_credentials",
        "That email or password doesn't match. Please try again.",
      ),
    );
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const client = show(<SignInForm />);
    client.setQueryData(["private"], "old account data");
    fill("Email", "ken@example.com");
    fill("Password", "test-only-password");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("alert");
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe(
      "test-only-password",
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat"));
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe(
      "",
    );
    expect(client.getQueryData(["private"])).toBeUndefined();
    expect(storage).not.toHaveBeenCalled();
  });

  it("routes unapproved users to the access screen", async () => {
    vi.mocked(authClient.getSession).mockResolvedValue({
      email: "guest@example.com",
      approved: false,
      recovery: false,
    });
    show(<SignInForm />);
    fill("Email", "guest@example.com");
    fill("Password", "test-only-password");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/not-approved"),
    );
  });

  it("shows unconfirmed-email guidance without exposing provider internals", async () => {
    vi.mocked(authClient.signInWithPassword).mockRejectedValue({
      code: "email_not_confirmed",
      message: "private payload",
    });
    show(<SignInForm />);
    fill("Email", "ken@example.com");
    fill("Password", "test-only-password");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Confirm your email",
    );
    expect(screen.queryByText("private payload")).toBeNull();
  });

  it("retries the Google action rather than accidentally submitting the password form", async () => {
    vi.mocked(authClient.signInWithGoogle).mockRejectedValueOnce(
      new AuthUiError("network", "Connection failed", true),
    );
    show(<SignInForm />);
    fireEvent.click(
      screen.getByRole("button", { name: "Continue with Google" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat"));
    expect(authClient.signInWithGoogle).toHaveBeenCalledTimes(2);
    expect(authClient.signInWithPassword).not.toHaveBeenCalled();
  });

  it("blocks duplicate password submissions while auth is pending", async () => {
    let finish!: () => void;
    vi.mocked(authClient.signInWithPassword).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    show(<SignInForm />);
    fill("Email", "ken@example.com");
    fill("Password", "test-only-password");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    const waiting = await screen.findByRole("button", { name: "Please wait…" });
    expect((waiting as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(waiting);
    expect(authClient.signInWithPassword).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat"));
  });

  it("checks password confirmation and shows the email-confirmation state", async () => {
    show(<SignUpForm />);
    fill("Email", "ken@example.com");
    fill("Password", "test-only-password");
    fill("Confirm password", "different-password");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await screen.findByText("Passwords don't match.");
    expect(authClient.signUp).not.toHaveBeenCalled();
    fill("Confirm password", "test-only-password");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await screen.findByRole("heading", { name: "Check your email" });
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.getByText("ken@example.com")).toBeTruthy();
  });

  it("uses non-enumerating reset confirmation copy", async () => {
    show(<RequestPasswordReset />);
    fill("Email", "ken@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    await screen.findByRole("heading", { name: "Check your inbox" });
    expect(screen.getByText(/If an account exists for/)).toBeTruthy();
  });

  it("does not offer a new-password form without a recovery session", async () => {
    show(<SetNewPassword />);
    await screen.findByText("This reset link is invalid or has expired.");
    expect(screen.queryByLabelText("New password")).toBeNull();
    expect(authClient.updatePassword).not.toHaveBeenCalled();
  });

  it("updates a password for a recovery session and removes password inputs", async () => {
    vi.mocked(authClient.getSession).mockResolvedValue({
      email: "ken@example.com",
      approved: true,
      recovery: true,
    });
    show(<SetNewPassword />);
    await screen.findByLabelText("New password");
    fill("New password", "test-only-password");
    fill("Confirm password", "test-only-password");
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    await screen.findByRole("heading", { name: "Password updated" });
    expect(authClient.updatePassword).toHaveBeenCalledWith(
      "test-only-password",
    );
    expect(screen.queryByLabelText("New password")).toBeNull();
  });

  it("shows the signed-in email and retains it if sign-out fails", async () => {
    vi.mocked(authClient.getSession).mockResolvedValue({
      email: "guest@example.com",
      approved: false,
      recovery: false,
    });
    vi.mocked(authClient.signOut).mockRejectedValueOnce(
      new AuthUiError("network", "Connection failed", true),
    );
    show(<NotApproved />);
    await screen.findByText("guest@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("alert");
    expect(screen.getByText("guest@example.com")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/sign-in"),
    );
  });
});
