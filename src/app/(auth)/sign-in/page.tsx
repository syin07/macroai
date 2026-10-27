import { SignInForm } from "@/components/auth/sign-in-form";
import { AuthFrame } from "@/components/shared/auth-frame";

export default function SignInPage() {
  return (
    <AuthFrame
      title="Sign in"
      description="Keep your meals and progress together, wherever you are."
    >
      <SignInForm />
    </AuthFrame>
  );
}
