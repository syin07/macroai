import { notFound } from "next/navigation";
import { ApiPlayground } from "@/components/dev/api-playground";
import { createFixtures } from "@/mocks/fixtures";

export default function ApiPlaygroundPage() {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.NEXT_PUBLIC_USE_MOCKS !== "1"
  )
    notFound();
  return <ApiPlayground fixtures={createFixtures()} />;
}
