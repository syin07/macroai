import { afterEach, expect, it, vi } from "vitest";
import { authClient, authError, AuthUiError } from "./auth";
import { createMockAuth } from "@/mocks/auth";
import { signOut } from "@/lib/auth/client";
vi.mock("@/lib/auth/client", () => ({ signOut: vi.fn(async () => {}) }));
it("delegates production sign-out to Sandy's auth helper", async () => {
  vi.stubEnv("NODE_ENV", "production");
  await authClient.signOut();
  expect(signOut).toHaveBeenCalledOnce();
});

afterEach(() => vi.unstubAllEnvs());

it("fails closed in production even when NEXT_PUBLIC_USE_MOCKS is set", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_USE_MOCKS", "1");
  await expect(
    authClient.signInWithPassword("test@example.com", "test-only-password"),
  ).rejects.toMatchObject({ code: "unavailable" });
  await expect(
    authClient.signUp("test@example.com", "test-only-password"),
  ).rejects.toMatchObject({ code: "unavailable" });
  await expect(
    authClient.updatePassword("test-only-password"),
  ).rejects.toMatchObject({ code: "unavailable" });
  await expect(authClient.getSession()).rejects.toMatchObject({
    code: "unavailable",
  });
});

it("does not enable auth stubs without explicit mock mode", async () => {
  vi.stubEnv("NEXT_PUBLIC_USE_MOCKS", "0");
  await expect(authClient.signInWithGoogle()).rejects.toMatchObject({
    code: "unavailable",
  });
});

it("requires a recovery session and consumes it after an update", async () => {
  const driver = createMockAuth(0);
  await expect(
    driver.updatePassword("test-only-password"),
  ).rejects.toMatchObject({ code: "invalid_recovery" });
  await driver.signInWithPassword("test@example.com", "test-only-password");
  await expect(
    driver.updatePassword("test-only-password"),
  ).rejects.toMatchObject({ code: "invalid_recovery" });
  driver.beginRecovery();
  await driver.updatePassword("test-only-password");
  expect(await driver.getSession()).toBeNull();
  await expect(
    driver.updatePassword("test-only-password"),
  ).rejects.toMatchObject({ code: "invalid_recovery" });
});

it("keeps session metadata in memory and clears it on sign out", async () => {
  const driver = createMockAuth(0);
  driver.setApproved(false);
  await driver.signInWithPassword("guest@example.com", "test-only-password");
  expect(await driver.getSession()).toEqual({
    email: "guest@example.com",
    approved: false,
    recovery: false,
  });
  await driver.signOut();
  expect(await driver.getSession()).toBeNull();
});

it("fails a scenario once so a retry can succeed", async () => {
  const driver = createMockAuth(0);
  driver.failNext(new AuthUiError("network", "Try again", true));
  await expect(driver.signInWithGoogle()).rejects.toMatchObject({
    code: "network",
  });
  await driver.signInWithGoogle();
  expect((await driver.getSession())?.approved).toBe(true);
});

it("maps provider errors without showing raw secrets or stack traces", () => {
  expect(
    authError({ code: "email_not_confirmed", message: "private payload" }).code,
  ).toBe("email_not_confirmed");
  expect(authError({ code: "otp_expired" }).code).toBe("invalid_recovery");
  expect(authError(new Error("private payload")).message).not.toContain(
    "private payload",
  );
});
