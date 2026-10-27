import Link from "next/link";
import { AuthFrame } from "@/components/shared/auth-frame";

export default function SignInPage() {
  return (
    <AuthFrame
      title="Sign in"
      description="Keep your meals and progress together, wherever you are."
    >
      <Link className="app-text-link rounded-md" href="/sign-up">
        Create an account
      </Link>
      <Link className="app-text-link rounded-md" href="/reset-password">
        Reset password
      </Link>
    </AuthFrame>
  );
}
