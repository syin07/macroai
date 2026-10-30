import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authClient, authError, AuthUiError } from "./auth";
import { createMockAuth } from "@/mocks/auth";
import * as realAuth from "@/lib/auth/client";
vi.mock("@/lib/auth/client", () => ({
  signOut: vi.fn(async () => {}),
  signInWithGoogle: vi.fn(async () => {}),
  signInWithPassword: vi.fn(async () => {}),
  signUp: vi.fn(async () => {}),
  sendPasswordReset: vi.fn(async () => {}),
  updatePassword: vi.fn(async () => {}),
  getSession: vi.fn(async () => null),
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(realAuth.getSession).mockResolvedValue(null);
});
it("delegates production sign-out to Sandy's auth helper", async () => {
  vi.stubEnv("NODE_ENV", "production");
  await authClient.signOut();
  expect(realAuth.signOut).toHaveBeenCalledOnce();
});

afterEach(() => vi.unstubAllEnvs());

it("uses real helpers in production even when NEXT_PUBLIC_USE_MOCKS is set", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_USE_MOCKS", "1");
  await authClient.signInWithPassword("test@example.com", "test-only-password");
  await authClient.signUp("test@example.com", "test-only-password");
  await authClient.signInWithGoogle();
  await authClient.sendPasswordReset("test@example.com");
  await expect(authClient.getSession()).resolves.toBeNull();
  expect(realAuth.signInWithPassword).toHaveBeenCalledWith(
    "test@example.com",
    "test-only-password",
  );
  expect(realAuth.signUp).toHaveBeenCalledWith(
    "test@example.com",
    "test-only-password",
  );
  expect(realAuth.signInWithGoogle).toHaveBeenCalledOnce();
  expect(realAuth.sendPasswordReset).toHaveBeenCalledWith("test@example.com");
});

it("does not enable auth stubs without explicit mock mode", async () => {
  vi.stubEnv("NEXT_PUBLIC_USE_MOCKS", "0");
  await authClient.signInWithGoogle();
  expect(realAuth.signInWithGoogle).toHaveBeenCalledOnce();
});

it("rechecks a verified recovery session before calling the real password update helper", async () => {
  vi.stubEnv("NODE_ENV", "production");
  await expect(
    authClient.updatePassword("test-only-password"),
  ).rejects.toMatchObject({ code: "invalid_recovery" });
  expect(realAuth.updatePassword).not.toHaveBeenCalled();
  vi.mocked(realAuth.getSession).mockResolvedValue({
    email: "ken@example.test",
    approved: true,
    recovery: false,
  });
  await expect(
    authClient.updatePassword("test-only-password"),
  ).rejects.toMatchObject({ code: "invalid_recovery" });
  vi.mocked(realAuth.getSession).mockResolvedValue({
    email: "ken@example.test",
    approved: true,
    recovery: true,
  });
  await authClient.updatePassword("test-only-password");
  expect(realAuth.updatePassword).toHaveBeenCalledOnce();
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
