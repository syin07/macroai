"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import {
  authClient,
  authError,
  authPreviewEnabled,
  type AuthUiError,
} from "@/lib/api/auth";
import { newPasswordSchema, resetRequestSchema } from "./schemas";
import {
  AuthErrorNotice,
  AuthField,
  AuthNotice,
  AuthSuccess,
  BackToSignIn,
  SubmitButton,
} from "./form-parts";

export function RequestPasswordReset() {
  const [sentEmail, setSentEmail] = useState<string | null>(null);
  const [error, setError] = useState<AuthUiError | null>(null);
  const form = useForm<z.infer<typeof resetRequestSchema>>({
    resolver: zodResolver(resetRequestSchema),
    defaultValues: { email: "" },
  });
  const submit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await authClient.sendPasswordReset(values.email);
      setSentEmail(values.email);
      form.reset();
    } catch (error) {
      setError(authError(error));
    }
  });
  return (
    <>
      <AuthNotice />
      {sentEmail ? (
        <AuthSuccess title="Check your inbox">
          <p>
            If an account exists for{" "}
            <strong className="break-all font-medium text-foreground">
              {sentEmail}
            </strong>
            , you&apos;ll receive a password-reset link. Check your spam folder
            too.
          </p>
        </AuthSuccess>
      ) : (
        <form
          noValidate
          onSubmit={submit}
          className="space-y-5"
          aria-busy={form.formState.isSubmitting}
        >
          <fieldset
            disabled={form.formState.isSubmitting || !authPreviewEnabled()}
            className="min-w-0 space-y-4"
          >
            <AuthField
              label="Email"
              type="email"
              autoComplete="email"
              binding={form.register("email")}
              error={form.formState.errors.email?.message}
            />
            <SubmitButton busy={form.formState.isSubmitting}>
              Send reset link
            </SubmitButton>
          </fieldset>
          <AuthErrorNotice
            error={error}
            busy={form.formState.isSubmitting}
            onRetry={() => void submit()}
          />
        </form>
      )}
      <BackToSignIn />
    </>
  );
}

export function SetNewPassword() {
  const client = useQueryClient();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<AuthUiError | null>(null);
  const session = useQuery({
    queryKey: ["auth", "recovery"],
    queryFn: () => authClient.getSession(),
    enabled: authPreviewEnabled(),
    retry: false,
    gcTime: 0,
  });
  const form = useForm<z.infer<typeof newPasswordSchema>>({
    resolver: zodResolver(newPasswordSchema),
    defaultValues: { password: "", confirm: "" },
  });
  const submit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await authClient.updatePassword(values.password);
      form.reset();
      setSaved(true);
      client.clear();
    } catch (error) {
      setError(authError(error));
    }
  });
  return (
    <>
      <AuthNotice />
      {!authPreviewEnabled() ? null : saved ? (
        <AuthSuccess title="Password updated">
          <p>You can now sign in with your new password.</p>
        </AuthSuccess>
      ) : session.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Checking reset link…
        </p>
      ) : session.error ? (
        <AuthErrorNotice
          error={authError(session.error)}
          onRetry={() => void session.refetch()}
        />
      ) : !session.data?.recovery ? (
        <div role="alert" className="space-y-4">
          <p className="text-sm leading-6">
            This reset link is invalid or has expired.
          </p>
          <Link
            href="/reset-password"
            className="app-text-link inline-flex min-h-11 items-center rounded-lg"
          >
            Request a new reset link
          </Link>
        </div>
      ) : (
        <form
          noValidate
          onSubmit={submit}
          className="space-y-5"
          aria-busy={form.formState.isSubmitting}
        >
          <fieldset
            disabled={form.formState.isSubmitting}
            className="min-w-0 space-y-4"
          >
            <AuthField
              label="New password"
              type="password"
              autoComplete="new-password"
              hint="Use at least 8 characters."
              binding={form.register("password")}
              error={form.formState.errors.password?.message}
            />
            <AuthField
              label="Confirm password"
              type="password"
              autoComplete="new-password"
              binding={form.register("confirm")}
              error={form.formState.errors.confirm?.message}
            />
            <SubmitButton busy={form.formState.isSubmitting}>
              Save new password
            </SubmitButton>
          </fieldset>
          <AuthErrorNotice
            error={error}
            busy={form.formState.isSubmitting}
            onRetry={() => void submit()}
          />
        </form>
      )}
      <BackToSignIn />
    </>
  );
}
