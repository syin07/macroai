import { notFound } from "next/navigation";
import { MealCardGallery } from "@/components/dev/meal-card-gallery";
import { createFixtures } from "@/mocks/fixtures";

export default function MealPreviewPage() {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.NEXT_PUBLIC_USE_MOCKS !== "1"
  )
    notFound();
  return <MealCardGallery fixtures={createFixtures()} />;
}
