import type { ReactNode } from "react";
import { LoadingSkeleton } from "@/components/shared/loading-skeleton";

export const control =
  "min-h-11 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] sm:text-sm";
export const action =
  "min-h-11 rounded-lg border border-[var(--app-line)] px-4 text-sm font-medium disabled:opacity-50";
export function SettingsSection({
  title,
  children,
  description,
}: {
  title: string;
  children: ReactNode;
  description?: string;
}) {
  return (
    <section
      aria-label={title}
      className="border-b border-[var(--app-line)] py-7 last:border-0"
    >
      <h2 className="mb-2 text-base font-semibold">{title}</h2>
      {description && (
        <p className="mb-4 text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      )}
      {children}
    </section>
  );
}
export function QueryNotice({
  pending,
  error,
  retry,
}: {
  pending: boolean;
  error: boolean;
  retry: () => void;
}) {
  return pending ? (
    <LoadingSkeleton label="Loading…" className="min-h-48 py-3" />
  ) : error ? (
    <p role="alert" className="text-sm">
      This section couldn’t load.{" "}
      <button className={action} onClick={retry}>
        Retry section
      </button>
    </p>
  ) : null;
}
