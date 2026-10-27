import { createBrowserClient as createSupabaseBrowserClient } from "@supabase/ssr";
import type { AMREntry, SupabaseClient } from "@supabase/supabase-js";
import { isApproved } from "./approval";
import { AUTH_CALLBACK_PATH, HOME_PATH, PASSWORD_UPDATE_PATH, supabaseConfig } from "./config";

// Browser-side auth for the sign-in, sign-up, reset-password, and not-approved pages.
// Every helper throws Supabase's AuthError on failure; map it to UI copy with its `code`
// (e.g. "invalid_credentials", "email_not_confirmed", "weak_password", "otp_expired").

export interface AuthSessionInfo {
  email: string;
  approved: boolean;
  recovery: boolean; // signed in through a password-reset link
}

// @supabase/ssr reuses one client per page in the browser.
export function createBrowserClient(): SupabaseClient {
  const { url, anonKey } = supabaseConfig();
  return createSupabaseBrowserClient(url, anonKey);
}

function callbackUrl(next: string): string {
  return `${window.location.origin}${AUTH_CALLBACK_PATH}?next=${encodeURIComponent(next)}`;
}

// Navigates away to Google and comes back through /auth/callback. The returned promise never
// resolves on success, so a caller's pending state stays up until the page unloads.
export async function signInWithGoogle(): Promise<never> {
  const { error } = await createBrowserClient().auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: callbackUrl(HOME_PATH) },
  });
  if (error) throw error;
  return new Promise<never>(() => {});
}

export async function signInWithPassword(email: string, password: string): Promise<void> {
  const { error } = await createBrowserClient().auth.signInWithPassword({ email, password });
  if (error) throw error;
}

// Sends a confirmation email. The link signs the user in and lands on the home page
// (or /not-approved if the email isn't on the allow-list).
export async function signUp(email: string, password: string): Promise<void> {
  const { error } = await createBrowserClient().auth.signUp({
    email,
    password,
    options: { emailRedirectTo: callbackUrl(HOME_PATH) },
  });
  if (error) throw error;
}

// The emailed link opens /reset-password?mode=update with a recovery session. It has to be opened
// in the same browser that requested it (PKCE keeps the verifier in a cookie here).
export async function sendPasswordReset(email: string): Promise<void> {
  const { error } = await createBrowserClient().auth.resetPasswordForEmail(email, {
    redirectTo: callbackUrl(PASSWORD_UPDATE_PATH),
  });
  if (error) throw error;
}

// Sets the new password, then ends the session so the user signs in again with it.
export async function updatePassword(password: string): Promise<void> {
  const supabase = createBrowserClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
  await supabase.auth.signOut({ scope: "local" });
}

export async function signOut(): Promise<void> {
  const { error } = await createBrowserClient().auth.signOut();
  if (error) throw error;
}

// The signed-in user's email, approval, and whether this session came from a reset link;
// null when signed out. For UI decisions only; the server re-checks everything.
export async function getSession(): Promise<AuthSessionInfo | null> {
  const supabase = createBrowserClient();
  const { data, error } = await supabase.auth.getClaims();
  if (!data) {
    if (error && error.name !== "AuthSessionMissingError") throw error;
    return null;
  }
  const amr: Array<AMREntry | string> = data.claims.amr ?? [];
  return {
    email: data.claims.email ?? "",
    approved: await isApproved(supabase),
    recovery: amr.some((entry) => (typeof entry === "string" ? entry : entry.method) === "recovery"),
  };
}
