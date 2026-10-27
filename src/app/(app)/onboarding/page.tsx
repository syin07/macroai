import { SlidersHorizontal } from "lucide-react";
import {
  EmptyPanel,
  HeaderLink,
  PageFrame,
} from "@/components/shared/page-frame";

export default function OnboardingPage() {
  return (
    <PageFrame
      title="Your profile"
      description="A few details to make MacroAI feel more like you."
      action={<HeaderLink href="/settings">Settings</HeaderLink>}
    >
      <EmptyPanel
        icon={SlidersHorizontal}
        title="Your goals, your pace"
        description="Your time zone, targets, and logging preferences belong here."
      />
    </PageFrame>
  );
}
