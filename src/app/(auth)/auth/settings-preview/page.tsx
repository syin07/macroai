import { notFound } from "next/navigation";
import { SettingsPreview } from "@/components/dev/settings-preview";
export default function SettingsPreviewPage() {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.NEXT_PUBLIC_USE_MOCKS !== "1"
  )
    notFound();
  return <SettingsPreview />;
}
