import { SignUpForm } from "@/components/auth/sign-up-form";
import { AuthFrame } from "@/components/shared/auth-frame";

export default function SignUpPage() {
  return (
    <AuthFrame
      title="Create an account"
      description="MacroAI is a private space. Access is limited to approved accounts."
    >
      <SignUpForm />
    </AuthFrame>
  );
}
