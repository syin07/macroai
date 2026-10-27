import { notFound } from "next/navigation";
import { DashboardPreview } from "@/components/dev/dashboard-preview";

export default function DashboardPreviewPage() {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.NEXT_PUBLIC_USE_MOCKS !== "1"
  )
    notFound();
  return <DashboardPreview />;
}
