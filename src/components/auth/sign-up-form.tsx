"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import {
  authClient,
  authError,
  authPreviewEnabled,
  type AuthUiError,
} from "@/lib/api/auth";
import { signUpSchema } from "./schemas";
import {
  AuthErrorNotice,
  AuthField,
  AuthNotice,
  AuthSuccess,
  BackToSignIn,
  SubmitButton,
} from "./form-parts";

export function SignUpForm() {
  const [sentEmail, setSentEmail] = useState<string | null>(null);
  const [error, setError] = useState<AuthUiError | null>(null);
  const form = useForm<z.infer<typeof signUpSchema>>({
    resolver: zodResolver(signUpSchema),
    defaultValues: { email: "", password: "", confirm: "" },
  });
  const submit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await authClient.signUp(values.email, values.password);
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
        <AuthSuccess title="Check your email">
          <p>
            Look for a confirmation link at{" "}
            <strong className="break-all font-medium text-foreground">
              {sentEmail}
            </strong>
            . Check your spam folder if it doesn&apos;t arrive.
          </p>
          <p className="mt-3">
            Confirming your email won&apos;t automatically grant access. Your
            account must also be approved.
          </p>
        </AuthSuccess>
      ) : (
        <form
          onSubmit={submit}
          noValidate
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
            <AuthField
              label="Password"
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
              Create account
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
