import { NotApproved } from "@/components/auth/not-approved";
import { AuthFrame } from "@/components/shared/auth-frame";

export default function NotApprovedPage() {
  return (
    <AuthFrame
      title="A private space"
      description="This account hasn't been approved for MacroAI. Access is currently limited to the two project members."
    >
      <NotApproved />
    </AuthFrame>
  );
}
