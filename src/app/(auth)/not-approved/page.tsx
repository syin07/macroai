import Link from "next/link";
import { AuthFrame } from "@/components/shared/auth-frame";

export default function NotApprovedPage() {
  return (
    <AuthFrame
      title="A private space"
      description="This account hasn't been approved for MacroAI. Access is currently limited to the two project members."
    >
      <Link className="app-text-link rounded-md" href="/sign-in">
        Back to sign in
      </Link>
    </AuthFrame>
  );
}
