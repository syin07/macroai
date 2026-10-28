"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { ChevronRight, History, Search } from "lucide-react";
import {
  useDaily,
  useMeals,
  useMealActions,
  usePreferences,
} from "@/hooks/use-api";
import { Input } from "@/components/ui/input";
import {
  EmptyPanel,
  HeaderLink,
  PageFrame,
} from "@/components/shared/page-frame";
import { MealDetailSheet } from "./meal-detail-sheet";
import { groupMeals } from "./group-meals";

const number = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);

function DayTotal({ date }: { date: string }) {
  const daily = useDaily(date);
  return (
    <span className="text-right text-xs font-normal tabular-nums text-muted-foreground">
      {daily.data ? (
        `${number(daily.data.consumed.calories)} kcal · day total`
      ) : daily.isPending ? (
        <span role="status">Loading total…</span>
      ) : (
        <button
          className="min-h-11 text-[var(--app-accent)]"
          onClick={() => void daily.refetch()}
        >
          Retry day total
        </button>
      )}
      {daily.data && daily.isError && (
        <button
          className="ml-2 min-h-11 text-[var(--app-accent)]"
          onClick={() => void daily.refetch()}
        >
          Refresh total
        </button>
      )}
    </span>
  );
}

export function HistoryScreen() {
  const preferences = usePreferences();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [dates, setDates] = useState({ from: "", to: "" });
  const [validation, setValidation] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const loadingMore = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const searching = search.trim() !== debounced;
  const meals = useMeals(
    {
      q: debounced || undefined,
      from: dates.from || undefined,
      to: dates.to || undefined,
    },
    { enabled: !!preferences.data && !searching },
  );
  const actions = useMealActions();
  const timezone = preferences.data?.timezone;
  const allMeals = meals.data?.pages.flatMap((page) => page.meals) ?? [];
  const groups = timezone
    ? groupMeals(
        allMeals.filter((meal) => actions[meal.id]?.meal !== null),
        timezone,
      )
    : [];
  const count = groups.reduce((total, group) => total + group.meals.length, 0);
  const filtered = !!debounced || !!dates.from || !!dates.to;
  const pending = preferences.isPending || (!!timezone && meals.isPending);

  const { fetchNextPage, hasNextPage } = meals;
  const more = useCallback(async () => {
    if (loadingMore.current || !hasNextPage || searching) return;
    loadingMore.current = true;
    try {
      await fetchNextPage();
    } finally {
      loadingMore.current = false;
    }
  }, [fetchNextPage, hasNextPage, searching]);
  useEffect(() => {
    const element = sentinel.current;
    if (
      !element ||
      typeof IntersectionObserver === "undefined" ||
      !meals.hasNextPage ||
      meals.isFetching ||
      meals.isFetchNextPageError ||
      searching ||
      selected
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries.some((entry) => entry.isIntersecting) &&
          !loadingMore.current
        )
          void more();
      },
      { rootMargin: "300px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
    // Reconnect when a page arrives so a still-visible sentinel can fill tall viewports.
  }, [
    count,
    meals.hasNextPage,
    meals.isFetching,
    meals.isFetchNextPageError,
    searching,
    selected,
    more,
  ]);
  function clear() {
    setSearch("");
    setDebounced("");
    setFrom("");
    setTo("");
    setDates({ from: "", to: "" });
    setValidation("");
  }
  return (
    <PageFrame
      title="History"
      description="Your meals, day by day."
      action={<HeaderLink href="/chat">Open chat</HeaderLink>}
    >
      <div className="history-screen mt-7 [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-[var(--app-accent)]">
        {preferences.isError && timezone && (
          <p role="alert" className="mb-3 text-sm">
            Using your last saved time zone.{" "}
            <button
              className="chat-text-button"
              onClick={() => void preferences.refetch()}
            >
              Retry time zone
            </button>
          </p>
        )}
        <label className="block text-xs font-medium" htmlFor="meal-search">
          Search meals or foods
        </label>
        <div className="relative mt-2">
          <Search
            size={18}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-3.5 text-muted-foreground"
          />
          <Input
            id="meal-search"
            type="search"
            maxLength={100}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Chicken, yogurt, toast…"
            className="min-h-11 pl-10 text-base"
          />
        </div>
        <form
          className="mt-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (from && to && from > to) {
              setValidation("Start date must be on or before end date.");
              return;
            }
            setValidation("");
            setDates({ from, to });
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <label className="min-w-0 text-xs font-medium">
              From
              <input
                type="date"
                aria-label="From date"
                value={from}
                max={to || undefined}
                onInput={(event) => {
                  setFrom(event.currentTarget.value);
                  setValidation("");
                }}
                onChange={(event) => {
                  setFrom(event.target.value);
                  setValidation("");
                }}
                className="mt-2 min-h-11 min-w-0 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
              />
            </label>
            <label className="min-w-0 text-xs font-medium">
              To
              <input
                type="date"
                aria-label="To date"
                value={to}
                min={from || undefined}
                onInput={(event) => {
                  setTo(event.currentTarget.value);
                  setValidation("");
                }}
                onChange={(event) => {
                  setTo(event.target.value);
                  setValidation("");
                }}
                className="mt-2 min-h-11 min-w-0 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
              />
            </label>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-4">
            <button type="submit" className="chat-text-button">
              Apply dates
            </button>
            {(search || from || to || filtered) && (
              <button
                type="button"
                onClick={clear}
                className="min-h-11 text-sm text-muted-foreground"
              >
                Clear filters
              </button>
            )}
            <p className="ml-auto text-xs text-muted-foreground">
              {timezone ? `Dates in ${timezone}` : "Loading time zone…"}
            </p>
          </div>
          {validation && (
            <p role="alert" className="text-sm">
              {validation}
            </p>
          )}
        </form>
        <div
          role="status"
          aria-live="polite"
          className="min-h-6 text-xs text-muted-foreground"
        >
          {searching
            ? "Updating search…"
            : meals.isFetching && !pending
              ? "Updating meals…"
              : meals.data && timezone
                ? `${count} ${count === 1 ? "meal" : "meals"} loaded${filtered ? " matching your filters" : ""}`
                : ""}
        </div>
        {preferences.isError && !timezone ? (
          <div role="alert" className="py-8 text-sm">
            <p>Your time zone couldn’t load.</p>
            <button
              className="chat-text-button"
              onClick={() => void preferences.refetch()}
            >
              Retry time zone
            </button>
          </div>
        ) : pending ? (
          <div
            role="status"
            aria-label="Loading meal history"
            className="mt-3 space-y-3"
          >
            {[0, 1, 2, 3].map((key) => (
              <div
                key={key}
                className="h-24 rounded-xl bg-[var(--app-surface)] motion-safe:animate-pulse"
              />
            ))}
          </div>
        ) : meals.isError && !meals.data ? (
          <div role="alert" className="py-8 text-sm">
            <p>Your history couldn’t load. Your filters are still here.</p>
            <button
              className="chat-text-button"
              onClick={() => void meals.refetch()}
            >
              Retry history
            </button>
          </div>
        ) : (
          <>
            {meals.isRefetchError && (
              <p role="alert" className="text-sm">
                Showing the last loaded meals.{" "}
                <button
                  className="chat-text-button"
                  onClick={() => void meals.refetch()}
                >
                  Retry history
                </button>
              </p>
            )}
            {!count && !searching ? (
              <EmptyPanel
                icon={History}
                title={
                  filtered ? "No matching meals" : "Your food log starts here"
                }
                description={
                  filtered
                    ? "Try another food name or widen the dates."
                    : "Log your first meal in chat. It will appear here once saved."
                }
                action={
                  filtered ? (
                    <button onClick={clear} className="chat-text-button">
                      Show all meals
                    </button>
                  ) : (
                    <HeaderLink href="/chat">Log a meal</HeaderLink>
                  )
                }
              />
            ) : (
              <div aria-busy={searching} className="mt-3">
                {groups.map(({ date, meals: dayMeals }) => (
                  <section key={date} aria-label={date} className="mb-5">
                    <h2 className="sticky top-0 z-10 flex min-h-12 items-center justify-between gap-3 border-b border-[var(--app-line)] bg-background py-2 text-sm font-medium">
                      <time dateTime={date}>
                        {formatInTimeZone(
                          `${date}T12:00:00Z`,
                          "UTC",
                          "EEE, MMM d, yyyy",
                        )}
                      </time>
                      <DayTotal date={date} />
                    </h2>
                    <ul>
                      {dayMeals.map((meal) => (
                        <li
                          key={meal.id}
                          className="border-b border-[var(--app-line)] last:border-0"
                        >
                          <button
                            disabled={searching}
                            onClick={(event) => {
                              returnFocus.current = event.currentTarget;
                              setSelected(meal.id);
                            }}
                            aria-label={`View ${meal.name}, ${formatInTimeZone(meal.consumed_at, timezone!, "MMM d, h:mm a")}`}
                            className="flex min-h-24 w-full items-center gap-3 rounded-lg py-4 text-left hover:bg-[var(--app-surface)]"
                          >
                            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                              <time dateTime={meal.consumed_at}>
                                {formatInTimeZone(
                                  meal.consumed_at,
                                  timezone!,
                                  "h:mm a",
                                )}
                              </time>
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block break-words text-sm font-medium">
                                {meal.name}
                              </span>
                              <span className="mt-1 block text-xs tabular-nums text-muted-foreground">
                                P {number(meal.totals.protein_g)} g · C{" "}
                                {number(meal.totals.carbs_g)} g · F{" "}
                                {number(meal.totals.fat_g)} g
                              </span>
                            </span>
                            <span className="shrink-0 text-right text-sm font-medium tabular-nums">
                              {number(meal.totals.calories)}
                              <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">
                                kcal
                              </span>
                            </span>
                            <ChevronRight
                              size={15}
                              aria-hidden="true"
                              className="shrink-0 text-muted-foreground"
                            />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
            <div ref={sentinel} aria-hidden="true" />
            {meals.hasNextPage && (
              <div className="py-4 text-center">
                {meals.isFetchNextPageError && (
                  <p role="alert" className="text-sm">
                    Earlier meals couldn’t load.
                  </p>
                )}
                <button
                  className="chat-text-button"
                  disabled={meals.isFetchingNextPage || searching}
                  onClick={() => void more()}
                >
                  {meals.isFetchingNextPage
                    ? "Loading earlier meals…"
                    : meals.isFetchNextPageError
                      ? "Retry earlier meals"
                      : "Load earlier meals"}
                </button>
              </div>
            )}
          </>
        )}
        {selected && timezone && (
          <MealDetailSheet
            key={selected}
            id={selected}
            timezone={timezone}
            onClose={() => setSelected(null)}
            returnFocus={returnFocus}
          />
        )}
      </div>
    </PageFrame>
  );
}
