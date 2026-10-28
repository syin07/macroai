import { notFound } from "next/navigation";
import { OnboardingPreview } from "@/components/dev/onboarding-preview";
export default function OnboardingPreviewPage() {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.NEXT_PUBLIC_USE_MOCKS !== "1"
  )
    notFound();
  return <OnboardingPreview />;
}
