import { History } from "lucide-react";
import {
  EmptyPanel,
  HeaderLink,
  PageFrame,
} from "@/components/shared/page-frame";

export default function HistoryPage() {
  return (
    <PageFrame
      title="History"
      description="Your meals, day by day."
      action={<HeaderLink href="/chat">Open chat</HeaderLink>}
    >
      <EmptyPanel
        icon={History}
        title="A place for every meal"
        description="Revisit what you ate, from today's meals to the ones worth remembering."
      />
    </PageFrame>
  );
}
