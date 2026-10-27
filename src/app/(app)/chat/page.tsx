import { MessageCircle } from "lucide-react";
import {
  EmptyPanel,
  HeaderLink,
  PageFrame,
} from "@/components/shared/page-frame";

export default function Chat() {
  return (
    <PageFrame
      title="Chat"
      description="Your food log, in one conversation."
      chat
      action={<HeaderLink href="/history">View history</HeaderLink>}
    >
      <EmptyPanel
        icon={MessageCircle}
        title="Start with what you ate"
        description="A simple space for your meals, questions, and daily nutrition."
      />
    </PageFrame>
  );
}
