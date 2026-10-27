"use client";

import { useState } from "react";
import Link from "next/link";
import { useDaily, useMeal } from "@/hooks/use-api";
import { MealEditor } from "@/components/meals/meal-editor";

const fields = [
  ["Protein", "protein_g", "P"],
  ["Carbs", "carbs_g", "C"],
  ["Fat", "fat_g", "F"],
] as const;
const number = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
function ratio(consumed: number, target: number) {
  return target > 0 ? Math.max(0, consumed / target) : consumed > 0 ? 2 : 0;
}
function Progress({
  name,
  consumed,
  target,
}: {
  name: string;
  consumed: number;
  target: number;
}) {
  const fraction = ratio(consumed, target);
  return (
    <div
      role="progressbar"
      aria-label={name}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.min(100, Math.round(fraction * 100))}
      aria-valuetext={`${number(consumed)} of ${number(target)}${consumed > target ? `, ${number(consumed - target)} over` : ""}`}
      className="relative h-1.5 overflow-hidden rounded-full bg-[var(--app-line)]"
    >
      <span
        className="absolute inset-y-0 left-0 rounded-full bg-[var(--app-accent)]"
        style={{ width: `${Math.min(100, fraction * 100)}%` }}
      />
      {fraction > 1 && (
        <span
          data-overflow="true"
          className="absolute inset-y-0 right-0 bg-muted-foreground"
          style={{
            width: `${Math.min(50, Math.max(3, (fraction - 1) * 100))}%`,
          }}
        />
      )}
    </div>
  );
}

function DailyMealEditor({ id, close }: { id: string; close: () => void }) {
  const meal = useMeal(id);
  if (
    meal.isPending ||
    meal.isError ||
    !meal.data ||
    meal.data.status !== "active"
  )
    return (
      <div className="py-3 text-sm" role={meal.isError ? "alert" : "status"}>
        <p>
          {meal.isPending
            ? "Loading meal…"
            : meal.isError
              ? "This meal couldn’t load."
              : "This meal is no longer available."}
        </p>
        {meal.isError && (
          <button
            className="chat-text-button"
            onClick={() => void meal.refetch()}
          >
            Retry meal
          </button>
        )}
        <button className="chat-text-button ml-3" onClick={close}>
          Close meal
        </button>
      </div>
    );
  return (
    <MealEditor
      target={{ kind: "meal", meal: meal.data }}
      onClose={close}
      onSaved={close}
    />
  );
}

export function DailyStrip() {
  const daily = useDaily();
  const [editing, setEditing] = useState<string | null>(null);
  const summary = daily.data;
  return (
    <div className="shrink-0 border-b border-[var(--app-line)] px-5 py-2 sm:px-8">
      {daily.isPending ? (
        <p role="status" className="py-3 text-sm text-muted-foreground">
          Loading today’s totals…
        </p>
      ) : !summary ? (
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
            <span className="min-w-0 flex-1">
              <span>
                Today{" "}
                <span className="ml-2 font-medium tabular-nums">
                  {number(summary.consumed.calories)}
                  {summary.targets
                    ? ` / ${number(summary.targets.calories)}`
                    : ""}{" "}
                  kcal
                </span>
              </span>
              {summary.targets && (
                <span className="mt-2 grid max-w-64 grid-cols-3 gap-3">
                  {fields.map(([name, key, initial]) => (
                    <span
                      key={key}
                      className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
                    >
                      <span>{initial}</span>
                      <span className="flex-1">
                        <Progress
                          name={`${name} today`}
                          consumed={summary.consumed[key]}
                          target={summary.targets![key]}
                        />
                      </span>
                    </span>
                  ))}
                </span>
              )}
            </span>
            <span className="text-xs text-[var(--app-accent)]">Details ↕</span>
          </summary>
          <div
            className="mt-3 overflow-y-auto overscroll-contain pb-4"
            style={{
              maxHeight:
                "clamp(48px, calc(var(--chat-viewport, 100dvh) - 540px), 240px)",
            }}
          >
            {daily.isError && (
              <div role="alert" className="text-sm">
                Showing the last totals.{" "}
                <button
                  className="chat-text-button"
                  onClick={() => void daily.refetch()}
                >
                  Retry totals
                </button>
              </div>
            )}
            <div className="flex items-center gap-5 py-3">
              {summary.targets && (
                <svg
                  viewBox="0 0 112 112"
                  width="104"
                  height="104"
                  role="img"
                  aria-label={`Calories: ${number(summary.consumed.calories)} of ${number(summary.targets.calories)} kcal`}
                  className="shrink-0 -rotate-90"
                >
                  <circle
                    cx="56"
                    cy="56"
                    r="40"
                    fill="none"
                    stroke="var(--app-line)"
                    strokeWidth="7"
                  />
                  <circle
                    cx="56"
                    cy="56"
                    r="40"
                    fill="none"
                    stroke="var(--app-accent)"
                    strokeWidth="7"
                    pathLength="100"
                    strokeDasharray={`${Math.min(100, ratio(summary.consumed.calories, summary.targets.calories) * 100)} 100`}
                    strokeLinecap="round"
                  />
                  {summary.consumed.calories > summary.targets.calories && (
                    <circle
                      cx="56"
                      cy="56"
                      r="48"
                      fill="none"
                      stroke="var(--muted-foreground)"
                      strokeWidth="3"
                      pathLength="100"
                      strokeDasharray={`${Math.min(100, (ratio(summary.consumed.calories, summary.targets.calories) - 1) * 100)} 100`}
                    />
                  )}
                </svg>
              )}
              <div className="tabular-nums">
                <p className="text-2xl font-semibold tracking-tight">
                  {number(summary.consumed.calories)}{" "}
                  <span className="text-sm font-normal text-muted-foreground">
                    kcal
                  </span>
                </p>
                {summary.targets ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {number(
                      Math.abs(
                        summary.remaining?.calories ??
                          summary.targets.calories - summary.consumed.calories,
                      ),
                    )}{" "}
                    kcal{" "}
                    {summary.consumed.calories > summary.targets.calories
                      ? "over"
                      : "remaining"}
                  </p>
                ) : (
                  <Link
                    href="/settings"
                    className="app-text-link flex min-h-11 items-center text-sm"
                  >
                    Set goals
                  </Link>
                )}
              </div>
            </div>
            <div className="space-y-4">
              {fields.map(([name, key]) => {
                const remaining =
                  summary.remaining?.[key] ??
                  (summary.targets
                    ? summary.targets[key] - summary.consumed[key]
                    : null);
                return (
                  <div key={key} className="text-xs tabular-nums">
                    <div className="mb-2 flex flex-wrap justify-between gap-1">
                      <span className="font-medium">{name}</span>
                      <span className="text-muted-foreground">
                        {number(summary.consumed[key])}
                        {summary.targets
                          ? ` / ${number(summary.targets[key])}`
                          : ""}{" "}
                        g
                        {remaining !== null
                          ? ` · ${number(Math.abs(remaining))} g ${remaining < 0 ? "over" : "remaining"}`
                          : ""}
                      </span>
                    </div>
                    {summary.targets && (
                      <Progress
                        name={name}
                        consumed={summary.consumed[key]}
                        target={summary.targets[key]}
                      />
                    )}
                  </div>
                );
              })}
            </div>
            <h2 className="mb-1 mt-6 text-sm font-medium">Today’s meals</h2>
            {summary.meals.length ? (
              <ol>
                {summary.meals.map((meal) => (
                  <li key={meal.id}>
                    <button
                      className="flex min-h-11 w-full items-center gap-3 border-b border-[var(--app-line)] py-2 text-left text-sm"
                      onClick={() => setEditing(meal.id)}
                      aria-label={`Edit ${meal.name}`}
                    >
                      <time
                        dateTime={meal.consumed_at}
                        className="shrink-0 text-xs tabular-nums text-muted-foreground"
                      >
                        {new Intl.DateTimeFormat("en-US", {
                          hour: "numeric",
                          minute: "2-digit",
                          timeZone: summary.timezone,
                        }).format(new Date(meal.consumed_at))}
                      </time>
                      <span className="min-w-0 flex-1 break-words">
                        {meal.name}
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {number(meal.totals.calories)} kcal
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="py-3 text-sm text-muted-foreground">
                No meals logged today.
              </p>
            )}
          </div>
        </details>
      )}
      {editing && (
        <DailyMealEditor
          key={editing}
          id={editing}
          close={() => setEditing(null)}
        />
      )}
    </div>
  );
}
