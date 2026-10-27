"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { PageFrame } from "@/components/shared/page-frame";
import { AuthUiError } from "@/lib/api/auth";
import { mockAuth } from "@/mocks/auth";
import { ThemePreview } from "./theme-preview";

const scenarios = [
  ["sign-in", "Sign in"],
  ["wrong-password", "Wrong password"],
  ["unconfirmed", "Unconfirmed email"],
  ["network", "Network failure"],
  ["rate-limit", "Too many attempts"],
  ["unapproved", "Unapproved account"],
  ["sign-up", "Sign up"],
  ["request-reset", "Request password reset"],
  ["new-password", "Valid recovery session"],
  ["expired-reset", "Expired reset link"],
  ["not-approved", "Signed-in, not approved"],
] as const;

export function AuthPlayground() {
  const router = useRouter(),
    client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  async function open(scenario: string) {
    setBusy(true);
    setStatus("");
    mockAuth.reset();
    client.clear();
    let path = "/sign-in";
    try {
      if (scenario === "wrong-password")
        mockAuth.failNext(
          new AuthUiError(
            "invalid_credentials",
            "That email or password doesn't match. Please try again.",
          ),
        );
      if (scenario === "unconfirmed")
        mockAuth.failNext(
          new AuthUiError(
            "email_not_confirmed",
            "Confirm your email before signing in. Check your inbox and spam folder.",
          ),
        );
      if (scenario === "network")
        mockAuth.failNext(
          new AuthUiError(
            "network",
            "We couldn't connect. Check your connection and try again.",
            true,
          ),
        );
      if (scenario === "rate-limit")
        mockAuth.failNext(
          new AuthUiError(
            "rate_limited",
            "Too many attempts. Wait a moment, then try again.",
            true,
          ),
        );
      if (scenario === "unapproved") mockAuth.setApproved(false);
      if (scenario === "sign-up") path = "/sign-up";
      if (scenario === "request-reset") path = "/reset-password";
      if (scenario === "new-password") {
        mockAuth.beginRecovery();
        path = "/reset-password?mode=update";
      }
      if (scenario === "expired-reset") path = "/reset-password?mode=update";
      if (scenario === "not-approved") {
        mockAuth.setApproved(false);
        await mockAuth.signInWithGoogle();
        path = "/not-approved";
      }
      router.push(path);
    } catch {
      setStatus("The preview couldn't be opened. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <PageFrame
      title="Auth previews"
      description="Development-only scenarios. Use made-up credentials; these flows never contact an auth service."
    >
      <div className="mt-6">
        <ThemePreview />
      </div>
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {scenarios.map(([key, label]) => (
          <Button
            key={key}
            variant="outline"
            className="min-h-11 justify-start rounded-xl"
            disabled={busy}
            onClick={() => void open(key)}
          >
            {label}
          </Button>
        ))}
      </div>
      <p className="mt-5 text-sm leading-6 text-muted-foreground">
        Failure scenarios fail once, then allow a retry. Sessions are held only
        in memory and disappear on reload. No account, email, password, or
        recovery token is persisted.
      </p>
      <p role="status" className="mt-4 text-sm">
        {busy ? "Opening preview…" : status}
      </p>
    </PageFrame>
  );
}
