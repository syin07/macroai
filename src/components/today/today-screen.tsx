"use client";

import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { Target } from "lucide-react";
import { useDaily } from "@/hooks/use-api";
import { EmptyPanel, HeaderLink, PageFrame } from "@/components/shared/page-frame";
import { LoadingSkeleton } from "@/components/shared/loading-skeleton";
import { MacroPie, PIE_FIELDS, fraction } from "./macro-pie";

const number = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
// Date-only labels must not move to the preceding day in the browser's local zone.
const dateLabel = (date: string) => formatInTimeZone(`${date}T12:00:00Z`, "UTC", "EEEE, MMM d");

export function TodayScreen() {
  const daily = useDaily();
  const summary = daily.data;
  return (
    <PageFrame
      title="Today"
      description={summary ? dateLabel(summary.date) : "Your calories and macros so far today."}
      action={<HeaderLink href="/chat">Log a meal</HeaderLink>}
    >
      {daily.isPending ? (
        <LoadingSkeleton label="Loading today’s progress…" kind="rows" rows={4} className="mt-8" />
      ) : !summary ? (
        <div role="alert" className="mt-8 flex items-center justify-between gap-3 text-sm">
          <p>Today’s progress couldn’t load.</p>
          <button className="chat-text-button" onClick={() => void daily.refetch()}>
            Retry
          </button>
        </div>
      ) : (
        <>
          {daily.isError && (
            <div role="alert" className="mt-6 text-sm">
              Showing the last totals.{" "}
              <button className="chat-text-button" onClick={() => void daily.refetch()}>
                Retry
              </button>
            </div>
          )}
          {summary.targets ? (
            <section className="mt-6 rounded-2xl border border-[var(--app-line)] bg-[var(--app-surface)] px-4 py-6 sm:px-8">
              <MacroPie consumed={summary.consumed} targets={summary.targets} />
              {summary.meals.length === 0 && (
                <p className="mt-4 text-center text-sm text-muted-foreground">
                  Nothing logged yet.{" "}
                  <Link href="/chat" className="app-text-link font-medium">
                    Log your first meal
                  </Link>
                </p>
              )}
            </section>
          ) : (
            <EmptyPanel
              icon={Target}
              title="Set your goals to see progress"
              description="Once you have calorie and macro targets, this page shows how far along you are each day."
              action={<HeaderLink href="/settings">Set goals</HeaderLink>}
            />
          )}
          <table className="mt-6 w-full text-sm">
            <caption className="sr-only">Today’s totals by nutrient</caption>
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="py-2 text-left font-medium">
                  Nutrient
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  Eaten
                </th>
                {summary.targets && (
                  <>
                    <th scope="col" className="py-2 text-right font-medium">
                      Goal
                    </th>
                    <th scope="col" className="py-2 text-right font-medium">
                      Left
                    </th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {PIE_FIELDS.map((field) => {
                const eaten = summary.consumed[field.key];
                const target = summary.targets?.[field.key];
                const left = summary.remaining?.[field.key];
                return (
                  <tr key={field.key} className="border-t border-[var(--app-line)]">
                    <th scope="row" className="py-3 pr-2 text-left font-medium">
                      {field.label}
                    </th>
                    <td className="px-2 py-3 text-right tabular-nums">
                      {number(eaten)} {field.unit}
                    </td>
                    {target !== undefined && left !== undefined && (
                      <>
                        <td className="px-2 py-3 text-right tabular-nums text-muted-foreground">
                          {number(target)} {field.unit}
                        </td>
                        <td
                          className="py-3 pl-2 text-right tabular-nums"
                          data-over={left < 0 ? "true" : undefined}
                        >
                          {left < 0 ? `${number(-left)} ${field.unit} over` : `${number(left)} ${field.unit}`}
                          <span className="ml-2 text-xs text-muted-foreground">
                            {Math.round(fraction(eaten, target) * 100)}%
                          </span>
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </PageFrame>
  );
}
