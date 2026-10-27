import { Settings } from "lucide-react";
import {
  EmptyPanel,
  HeaderLink,
  PageFrame,
} from "@/components/shared/page-frame";

export default function SettingsPage() {
  return (
    <PageFrame
      title="Settings"
      description="Your preferences, goals, and account."
      action={<HeaderLink href="/onboarding">Your profile</HeaderLink>}
    >
      <EmptyPanel
        icon={Settings}
        title="Make room for your routine"
        description="Keep your daily targets and logging preferences in one place."
      />
    </PageFrame>
  );
}
