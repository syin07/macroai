import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/auth/proxy";

// Next.js 16 renamed middleware.ts to proxy.ts. Rules live in src/lib/auth/proxy.ts.
export function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Everything except build assets, the PWA manifest, and static files in public/.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|txt|xml)$).*)",
  ],
};
