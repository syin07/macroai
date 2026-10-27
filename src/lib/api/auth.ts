// Frontend boundary for H2. Sandy owns the real helpers in src/lib/auth/client.ts.
export type AuthUiErrorCode =
  | "invalid_credentials"
  | "email_not_confirmed"
  | "network"
  | "rate_limited"
  | "weak_password"
  | "invalid_recovery"
  | "unavailable";

export class AuthUiError extends Error {
  constructor(
    public readonly code: AuthUiErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "AuthUiError";
  }
}
export interface AuthSessionView {
  email: string;
  approved: boolean;
  recovery: boolean;
}
export interface AuthAdapter {
  signInWithGoogle(): Promise<void>;
  signInWithPassword(email: string, password: string): Promise<void>;
  signUp(email: string, password: string): Promise<void>;
  sendPasswordReset(email: string): Promise<void>;
  updatePassword(password: string): Promise<void>;
  signOut(): Promise<void>;
  getSession(): Promise<AuthSessionView | null>;
}

export function authPreviewEnabled() {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.NEXT_PUBLIC_USE_MOCKS === "1"
  );
}
async function adapter(): Promise<AuthAdapter> {
  if (authPreviewEnabled()) return (await import("@/mocks/auth")).mockAuth;
  // H2 has not landed. Never use a simulated session as production authentication.
  throw new AuthUiError(
    "unavailable",
    "Account access is temporarily unavailable. Please try again later.",
  );
}
export const authClient: AuthAdapter = {
  async signInWithGoogle() {
    return (await adapter()).signInWithGoogle();
  },
  async signInWithPassword(email, password) {
    return (await adapter()).signInWithPassword(email, password);
  },
  async signUp(email, password) {
    return (await adapter()).signUp(email, password);
  },
  async sendPasswordReset(email) {
    return (await adapter()).sendPasswordReset(email);
  },
  async updatePassword(password) {
    return (await adapter()).updatePassword(password);
  },
  async signOut() {
    return (await adapter()).signOut();
  },
  async getSession() {
    return (await adapter()).getSession();
  },
};

export function authError(error: unknown): AuthUiError {
  if (error instanceof AuthUiError) return error;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  if (code === "invalid_credentials")
    return new AuthUiError(
      "invalid_credentials",
      "That email or password doesn't match. Please try again.",
    );
  if (code === "email_not_confirmed")
    return new AuthUiError(
      "email_not_confirmed",
      "Confirm your email before signing in. Check your inbox and spam folder.",
    );
  if (
    code === "over_request_rate_limit" ||
    code === "over_email_send_rate_limit"
  )
    return new AuthUiError(
      "rate_limited",
      "Too many attempts. Wait a moment, then try again.",
      true,
    );
  if (code === "weak_password")
    return new AuthUiError(
      "weak_password",
      "Choose a stronger password with at least 8 characters.",
    );
  if (["otp_expired", "flow_state_expired", "session_not_found"].includes(code))
    return new AuthUiError(
      "invalid_recovery",
      "This reset link is invalid or has expired. Request a new one.",
    );
  // Never display provider internals, tokens, or arbitrary messages.
  return new AuthUiError(
    "network",
    "We couldn't connect. Check your connection and try again.",
    true,
  );
}
