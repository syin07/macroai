import { ChartLine } from "lucide-react";
import {
  EmptyPanel,
  HeaderLink,
  PageFrame,
} from "@/components/shared/page-frame";

export default function InsightsPage() {
  return (
    <PageFrame
      title="Insights"
      description="See your everyday nutrition in perspective."
      action={<HeaderLink href="/history">View history</HeaderLink>}
    >
      <EmptyPanel
        icon={ChartLine}
        title="Small entries. A bigger picture."
        description="Your recorded days will help you see patterns in calories and macros over time."
      />
    </PageFrame>
  );
}
