import { notFound } from "next/navigation";
import { PhotoInputPreview } from "@/components/dev/photo-input-preview";

export default function PhotoPreviewPage() {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.NEXT_PUBLIC_USE_MOCKS !== "1"
  )
    notFound();
  return <PhotoInputPreview />;
}
