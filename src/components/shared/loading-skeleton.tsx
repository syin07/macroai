import { Skeleton } from "@/components/ui/skeleton";

/** Geometry-only placeholders; one quiet announcement instead of every bar. */
export function LoadingSkeleton({
  label = "Loading…",
  kind = "form",
  rows = 3,
  className = "",
}: {
  label?: string;
  kind?: "form" | "chat" | "rows" | "summary";
  rows?: number;
  className?: string;
}) {
  return (
    <div role="status" aria-label={label} className={className}>
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="space-y-4">
        {kind === "summary" ? (
          <div className="py-3">
            <Skeleton className="h-5 w-44" />
            <Skeleton className="mt-2 h-1.5 w-64 max-w-full" />
          </div>
        ) : (
          Array.from({ length: rows }, (_, index) =>
            kind === "form" ? (
              <div key={index} className="space-y-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-11 w-full" />
              </div>
            ) : kind === "chat" ? (
              <Skeleton
                key={index}
                className={`h-20 w-3/4 rounded-2xl ${index % 2 === 0 ? "ml-auto" : ""}`}
              />
            ) : (
              <div
                key={index}
                className="flex h-16 items-center justify-between gap-6 border-b border-[var(--app-line)]"
              >
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-4 w-12" />
              </div>
            ),
          )
        )}
      </div>
    </div>
  );
}
