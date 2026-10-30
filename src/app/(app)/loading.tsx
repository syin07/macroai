import { LoadingSkeleton } from "@/components/shared/loading-skeleton";
export default function Loading() {
  return (
    <LoadingSkeleton
      label="Loading page…"
      className="mx-auto mt-10 max-w-2xl px-5"
    />
  );
}
