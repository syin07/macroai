import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { apiErrorBody, errorStatus } from "@/lib/api-error";
import { isApproved } from "./approval";
import { NOT_APPROVED_PATH, SIGN_IN_PATH, isApiPath, isPublicPage, supabaseConfig } from "./config";

// Runs before every non-static request (src/proxy.ts):
//   1. Refresh the Supabase session and write the new cookies onto whatever response we return.
//   2. /api/**: signed out → 401 JSON (never a redirect; the API client follows redirects).
//      Approval is checked by requireUser() in each route.
//   3. Public pages (sign-in, sign-up, reset-password, not-approved, auth callback): pass through.
//   4. Every other page: signed out → /sign-in, signed in but not approved → /not-approved.
// This is the optimistic check; route handlers and RLS are the real enforcement.
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });
  const { url, anonKey } = supabaseConfig();
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        for (const [key, value] of Object.entries(headers ?? {})) response.headers.set(key, value);
      },
    },
  });

  // Don't run code between createServerClient and getClaims: it refreshes an expired session.
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims.sub);
  const { pathname } = request.nextUrl;

  if (isApiPath(pathname)) {
    if (signedIn) return response;
    return withSessionCookies(
      NextResponse.json(apiErrorBody("unauthenticated"), { status: errorStatus("unauthenticated") }),
      response,
    );
  }
  if (isPublicPage(pathname)) return response;
  if (!signedIn) return withSessionCookies(redirect(request, SIGN_IN_PATH), response);

  let approved = false;
  try {
    approved = await isApproved(supabase);
  } catch {
    // Fail closed: the not-approved page re-checks and offers sign-out.
  }
  if (!approved) return withSessionCookies(redirect(request, NOT_APPROVED_PATH), response);
  return response;
}

function redirect(request: NextRequest, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, request.url));
}

// Carry refreshed session cookies (and their no-cache headers) onto a response we built ourselves,
// otherwise the browser keeps the old tokens and the session drops.
function withSessionCookies(target: NextResponse, source: NextResponse): NextResponse {
  for (const cookie of source.cookies.getAll()) target.cookies.set(cookie);
  for (const header of ["cache-control", "expires", "pragma"]) {
    const value = source.headers.get(header);
    if (value) target.headers.set(header, value);
  }
  return target;
}
