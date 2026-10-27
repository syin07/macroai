import { notFound } from "next/navigation";
import { InsightsPreview } from "@/components/dev/insights-preview";
export default function InsightsPreviewPage() {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.NEXT_PUBLIC_USE_MOCKS !== "1"
  )
    notFound();
  return <InsightsPreview />;
}
