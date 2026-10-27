import { notFound } from "next/navigation";
import { HistoryPreview } from "@/components/dev/history-preview";

export default function HistoryPreviewPage() {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.NEXT_PUBLIC_USE_MOCKS !== "1"
  )
    notFound();
  return <HistoryPreview />;
}
