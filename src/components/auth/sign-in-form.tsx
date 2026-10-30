"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { authClient, authError, AuthUiError } from "@/lib/api/auth";
import { signInSchema } from "./schemas";
import {
  AuthErrorNotice,
  AuthField,
  AuthNotice,
  SubmitButton,
} from "./form-parts";

export function SignInForm() {
  const router = useRouter(),
    client = useQueryClient();
  const [pending, setPending] = useState<"password" | "google" | null>(null);
  const [lastAction, setLastAction] = useState<"password" | "google">(
    "password",
  );
  const [error, setError] = useState<AuthUiError | null>(null);
  const form = useForm<z.infer<typeof signInSchema>>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: "", password: "" },
  });
  async function finish() {
    const session = await authClient.getSession();
    if (!session)
      throw new AuthUiError(
        "unavailable",
        "Your session could not be opened. Please sign in again.",
        true,
      );
    form.reset();
    await client.cancelQueries();
    client.clear();
    router.replace(session.approved ? "/chat" : "/not-approved");
    router.refresh();
  }
  const submit = form.handleSubmit(async (values) => {
    setPending("password");
    setLastAction("password");
    setError(null);
    try {
      await authClient.signInWithPassword(values.email, values.password);
      await finish();
    } catch (error) {
      setError(authError(error));
      setPending(null);
    }
  });
  async function google() {
    setPending("google");
    setLastAction("google");
    setError(null);
    try {
      await authClient.signInWithGoogle();
      await finish();
    } catch (error) {
      setError(authError(error));
      setPending(null);
    }
  }
  const disabled = !!pending;
  return (
    <div className="space-y-5">
      <AuthNotice />
      <Button
        type="button"
        variant="outline"
        className="h-11 w-full rounded-xl bg-background"
        disabled={disabled}
        onClick={() => void google()}
      >
        {pending === "google" ? "Connecting…" : "Continue with Google"}
      </Button>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or with email
        <span className="h-px flex-1 bg-border" />
      </div>
      <form
        noValidate
        onSubmit={submit}
        className="space-y-5"
        aria-busy={!!pending}
      >
        <fieldset disabled={disabled} className="min-w-0 space-y-4">
          <AuthField
            label="Email"
            type="email"
            autoComplete="email"
            binding={form.register("email")}
            error={form.formState.errors.email?.message}
          />
          <AuthField
            label="Password"
            type="password"
            autoComplete="current-password"
            binding={form.register("password")}
            error={form.formState.errors.password?.message}
          />
          <SubmitButton busy={pending === "password"}>Sign in</SubmitButton>
        </fieldset>
        <AuthErrorNotice
          error={error}
          busy={!!pending}
          onRetry={() => void (lastAction === "google" ? google() : submit())}
        />
      </form>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <Link href="/sign-up" className="app-text-link rounded-lg">
          Create an account
        </Link>
        <Link href="/reset-password" className="app-text-link rounded-lg">
          Forgot password?
        </Link>
      </div>
    </div>
  );
}
