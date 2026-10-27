// Supabase connection settings and auth route rules shared by the server client, the browser client,
// the proxy, and the OAuth callback. Only NEXT_PUBLIC_* values live here, so it is safe in client code.

export function supabaseConfig(): { url: string; anonKey: string } {
  // Literal property access so Next.js inlines these into the client bundle.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set (see .env.example).");
  }
  return { url, anonKey };
}

export const SIGN_IN_PATH = "/sign-in";
export const NOT_APPROVED_PATH = "/not-approved";
export const HOME_PATH = "/chat";
export const PASSWORD_UPDATE_PATH = "/reset-password?mode=update";
export const AUTH_CALLBACK_PATH = "/auth/callback";

// Pages anyone can open. Every other page is an (app) page and needs an approved session (default deny).
const PUBLIC_PAGES = ["/sign-in", "/sign-up", "/reset-password", "/not-approved", "/auth"];

export function isPublicPage(pathname: string): boolean {
  return PUBLIC_PAGES.some((page) => pathname === page || pathname.startsWith(`${page}/`));
}

export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

// Turn an untrusted `next` parameter into a same-origin path, or fall back to the home page.
// Rejects absolute URLs, protocol-relative `//host`, backslash tricks, and anything else that
// would resolve to another origin.
export function safeNextPath(next: string | null | undefined, fallback: string = HOME_PATH): string {
  if (!next || !next.startsWith("/") || next.includes("\\")) return fallback;
  const base = "http://same-origin.invalid";
  let url: URL;
  try {
    url = new URL(next, base);
  } catch {
    return fallback;
  }
  if (url.origin !== base) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}
