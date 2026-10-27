import { notFound } from "next/navigation";
import { AuthPlayground } from "@/components/dev/auth-playground";

export default function AuthPlaygroundPage() {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.NEXT_PUBLIC_USE_MOCKS !== "1"
  )
    notFound();
  return <AuthPlayground />;
}
