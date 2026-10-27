"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  authClient,
  authError,
  authPreviewEnabled,
  type AuthUiError,
} from "@/lib/api/auth";
import { AuthErrorNotice, AuthNotice, BackToSignIn } from "./form-parts";

export function NotApproved() {
  const router = useRouter(),
    client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthUiError | null>(null);
  const session = useQuery({
    queryKey: ["auth", "session"],
    queryFn: () => authClient.getSession(),
    enabled: authPreviewEnabled(),
    retry: false,
    gcTime: 0,
  });
  async function signOut() {
    setBusy(true);
    setError(null);
    try {
      await authClient.signOut();
      client.clear();
      router.replace("/sign-in");
      router.refresh();
    } catch (error) {
      setError(authError(error));
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5">
      <AuthNotice />
      {!authPreviewEnabled() ? (
        <BackToSignIn />
      ) : session.isPending ? (
        <p role="status">Loading account…</p>
      ) : session.error ? (
        <AuthErrorNotice
          error={authError(session.error)}
          onRetry={() => void session.refetch()}
        />
      ) : session.data ? (
        <>
          <p className="break-all rounded-xl border border-[var(--app-line)] bg-background px-4 py-3 text-sm">
            {session.data.email}
          </p>
          <Button
            type="button"
            className="h-11 w-full rounded-xl"
            disabled={busy}
            onClick={() => void signOut()}
          >
            {busy ? "Signing out…" : "Sign out"}
          </Button>
          <AuthErrorNotice
            error={error}
            busy={busy}
            onRetry={() => void signOut()}
          />
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            You&apos;re not signed in.
          </p>
          <BackToSignIn />
        </>
      )}
    </div>
  );
}
