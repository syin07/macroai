import {
  AuthUiError,
  type AuthAdapter,
  type AuthSessionView,
} from "@/lib/api/auth";

export function createMockAuth(delay = 650) {
  let session: AuthSessionView | null = null;
  let nextError: AuthUiError | undefined;
  let approved = true;
  async function wait() {
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (nextError) {
      const error = nextError;
      nextError = undefined;
      throw error;
    }
  }
  const mock: AuthAdapter = {
    async signInWithGoogle() {
      await wait();
      session = { email: "ken@example.com", approved, recovery: false };
    },
    async signInWithPassword(email) {
      await wait();
      session = { email, approved, recovery: false };
    },
    async signUp() {
      await wait();
    },
    async sendPasswordReset() {
      await wait();
    },
    async updatePassword() {
      await wait();
      if (!session?.recovery)
        throw new AuthUiError(
          "invalid_recovery",
          "This reset link is invalid or has expired. Request a new one.",
        );
      // End the simulated recovery session. No password is retained.
      session = null;
    },
    async signOut() {
      await wait();
      session = null;
    },
    async getSession() {
      await wait();
      return session ? { ...session } : null;
    },
  };
  return {
    ...mock,
    failNext(error: AuthUiError) {
      nextError = error;
    },
    setApproved(value: boolean) {
      approved = value;
    },
    beginRecovery(email = "ken@example.com") {
      session = { email, approved, recovery: true };
    },
    reset() {
      session = null;
      nextError = undefined;
      approved = true;
    },
  };
}

export const mockAuth = createMockAuth();
