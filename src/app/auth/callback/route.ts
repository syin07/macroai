import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createServerClient } from "@/lib/auth/server";
import { SIGN_IN_PATH, safeNextPath } from "@/lib/auth/config";

// Landing point for Google OAuth and email links (sign-up confirmation, password reset).
// Exchanges the one-time code for a session cookie, then redirects to `next`, same-origin paths only.
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const next = safeNextPath(params.get("next"));
  const code = params.get("code");
  const tokenHash = params.get("token_hash");
  const type = params.get("type") as EmailOtpType | null;

  let ok = false;
  if (code || (tokenHash && type)) {
    const supabase = await createServerClient();
    const { error } = code
      ? await supabase.auth.exchangeCodeForSession(code)
      : await supabase.auth.verifyOtp({ token_hash: tokenHash!, type: type! });
    ok = !error;
  }

  const destination = ok ? next : `${SIGN_IN_PATH}?error=auth_callback`;
  return NextResponse.redirect(new URL(destination, request.url));
}
