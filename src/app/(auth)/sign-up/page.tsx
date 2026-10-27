import Link from "next/link";
import { AuthFrame } from "@/components/shared/auth-frame";

export default function SignUpPage() {
  return (
    <AuthFrame
      title="Create an account"
      description="MacroAI is a private space. Access is limited to approved accounts."
    >
      <Link className="app-text-link rounded-md" href="/sign-in">
        Back to sign in
      </Link>
    </AuthFrame>
  );
}
