import {
  RequestPasswordReset,
  SetNewPassword,
} from "@/components/auth/password-reset";
import { AuthFrame } from "@/components/shared/auth-frame";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const update = (await searchParams).mode === "update";
  return (
    <AuthFrame
      title={update ? "Choose a new password" : "Reset password"}
      description={
        update
          ? "A fresh start for your account."
          : "We'll send a link to help you get back in."
      }
    >
      {update ? <SetNewPassword /> : <RequestPasswordReset />}
    </AuthFrame>
  );
}
