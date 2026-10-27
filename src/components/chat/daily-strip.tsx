"use client";

import Link from "next/link";
import { useDaily } from "@/hooks/use-api";

export function DailyStrip() {
  const daily = useDaily();
  return (
    <div className="shrink-0 border-b border-[var(--app-line)] px-5 py-2 sm:px-8">
      {daily.isPending ? (
        <p role="status" className="py-3 text-sm text-muted-foreground">
          Loading today’s totals…
        </p>
      ) : daily.isError ? (
        <div className="flex items-center justify-between gap-2 text-sm">
          <p>Today’s totals couldn’t load.</p>
          <button
            className="chat-text-button"
            onClick={() => void daily.refetch()}
          >
            Retry totals
          </button>
        </div>
      ) : (
        <details className="mx-auto max-w-2xl">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg text-sm">
            <span>
              Today{" "}
              <span className="ml-2 tabular-nums font-medium">
                {Math.round(daily.data.consumed.calories).toLocaleString()}
                {daily.data.targets
                  ? ` / ${daily.data.targets.calories.toLocaleString()}`
                  : ""}{" "}
                kcal
              </span>
            </span>
            <span className="text-xs text-[var(--app-accent)]">Details ↕</span>
          </summary>
          <div className="grid grid-cols-3 gap-3 pb-4 text-xs tabular-nums">
            {(
              [
                ["Protein", "protein_g"],
                ["Carbs", "carbs_g"],
                ["Fat", "fat_g"],
              ] as const
            ).map(([name, key]) => (
              <p key={key}>
                <span className="block text-muted-foreground">{name}</span>
                <span className="mt-1 block">
                  {daily.data.consumed[key]}
                  {daily.data.targets ? ` / ${daily.data.targets[key]}` : ""} g
                </span>
              </p>
            ))}
            {!daily.data.targets && (
              <Link
                href="/settings"
                className="app-text-link col-span-3 flex min-h-11 items-center"
              >
                Set goals
              </Link>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
