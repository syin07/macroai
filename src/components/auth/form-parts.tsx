"use client";

import { useId } from "react";
import type { UseFormRegisterReturn } from "react-hook-form";
import { LoaderCircle, Check, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authPreviewEnabled, type AuthUiError } from "@/lib/api/auth";

export function AuthNotice() {
  if (process.env.NODE_ENV === "production" || !authPreviewEnabled())
    return null;
  return (
    <p
      className="mb-6 rounded-xl border border-[var(--app-line)] px-3 py-2.5 text-xs leading-5 text-muted-foreground"
      role="status"
    >
      Preview only. No accounts are created, no emails are sent, and sessions
      reset on reload. Use a test password.
    </p>
  );
}
export function AuthField({
  label,
  binding,
  error,
  type = "text",
  autoComplete,
  hint,
}: {
  label: string;
  binding: UseFormRegisterReturn;
  error?: string;
  type?: string;
  autoComplete?: string;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input
        {...binding}
        id={id}
        type={type}
        autoComplete={autoComplete}
        autoCapitalize="none"
        spellCheck={false}
        aria-invalid={!!error}
        required
        aria-required="true"
        aria-describedby={
          [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
            .filter(Boolean)
            .join(" ") || undefined
        }
        className="h-11 rounded-xl bg-background px-3 text-base"
      />
      {hint && (
        <p
          id={`${id}-hint`}
          className="text-xs leading-5 text-muted-foreground"
        >
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs leading-5 text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
export function AuthErrorNotice({
  error,
  onRetry,
  busy = false,
}: {
  error: AuthUiError | null;
  onRetry?: () => void;
  busy?: boolean;
}) {
  if (!error) return null;
  return (
    <div
      className="space-y-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm leading-6"
      role="alert"
    >
      <p>{error.message}</p>
      {error.retryable && onRetry && (
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={onRetry}
          disabled={busy}
        >
          Try again
        </Button>
      )}
    </div>
  );
}
export function SubmitButton({
  children,
  busy,
  disabled,
}: {
  children: React.ReactNode;
  busy: boolean;
  disabled?: boolean;
}) {
  return (
    <Button
      type="submit"
      className="h-11 w-full rounded-xl"
      disabled={disabled || busy}
    >
      {busy && (
        <LoaderCircle
          className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      )}
      {busy ? "Please wait…" : children}
    </Button>
  );
}
export function AuthSuccess({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div role="status" className="space-y-4">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--app-accent-soft)] text-[var(--app-accent)]">
        <Check size={20} aria-hidden="true" />
      </span>
      <h2 className="text-lg font-medium tracking-tight">{title}</h2>
      <div className="text-sm leading-6 text-muted-foreground">{children}</div>
    </div>
  );
}
export function BackToSignIn() {
  return (
    <Link
      className="app-text-link mt-6 inline-flex min-h-11 items-center gap-2 rounded-lg text-sm"
      href="/sign-in"
    >
      <ArrowLeft size={15} aria-hidden="true" />
      Back to sign in
    </Link>
  );
}
