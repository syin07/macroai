import Link from "next/link";
import { AuthFrame } from "@/components/shared/auth-frame";

export default function ResetPasswordPage() {
  return (
    <AuthFrame
      title="Reset password"
      description="Get back to your personal food log."
    >
      <Link className="app-text-link rounded-md" href="/sign-in">
        Back to sign in
      </Link>
    </AuthFrame>
  );
}
