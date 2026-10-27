import { notFound } from "next/navigation";
import { MealCardGallery } from "@/components/dev/meal-card-gallery";
import { createFixtures } from "@/mocks/fixtures";

// Public auth-page namespace keeps frontend mock previews usable with H2's default-deny proxy.
// No session is fabricated; API routes and app pages retain Sandy's auth enforcement.
export default function MealEditorPreview() {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.NEXT_PUBLIC_USE_MOCKS !== "1"
  )
    notFound();
  return <MealCardGallery fixtures={createFixtures()} />;
}
