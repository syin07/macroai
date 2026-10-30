"use client";

import { useEffect, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { ChartLine } from "lucide-react";
import {
  useDaily,
  useMeals,
  useMealActions,
  usePreferences,
} from "@/hooks/use-api";
import { groupMeals } from "@/components/history/group-meals";
import {
  EmptyPanel,
  HeaderLink,
  PageFrame,
} from "@/components/shared/page-frame";
import { action } from "@/components/settings/settings-shared";
import { LoadingSkeleton } from "@/components/shared/loading-skeleton";

const number = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
// Date-only labels must not move to the preceding day in the browser's local zone.
const dateLabel = (date: string) =>
  formatInTimeZone(`${date}T12:00:00Z`, "UTC", "MMM d, yyyy");

function RecordedDay({ date }: { date: string }) {
  const daily = useDaily(date);
  return (
    <tr className="border-t border-[var(--app-line)]">
      <th scope="row" className="py-5 pr-2 text-left text-sm font-medium">
        <time dateTime={date}>{dateLabel(date)}</time>
      </th>
      {daily.data ? (
        <>
          <td className="px-2 py-5 text-right tabular-nums">
            {number(daily.data.consumed.calories)}
          </td>
          <td className="py-5 pl-2 text-right tabular-nums">
            {number(daily.data.consumed.protein_g)} g
            {daily.isError && (
              <button
                className="chat-text-button block w-full text-right text-xs"
                disabled={daily.isFetching}
                onClick={() => void daily.refetch()}
              >
                {daily.isFetching
                  ? "Refreshing…"
                  : `Refresh ${dateLabel(date)}`}
              </button>
            )}
          </td>
        </>
      ) : (
        <td colSpan={2} className="py-3 text-right text-sm">
          {daily.isFetching ? (
            <LoadingSkeleton
              label={`Loading totals for ${dateLabel(date)}…`}
              kind="summary"
            />
          ) : (
            <>
              <span className="sr-only" role="alert">
                Totals couldn’t load for {dateLabel(date)}.
              </span>
              <button className={action} onClick={() => void daily.refetch()}>
                Retry {dateLabel(date)}
              </button>
            </>
          )}
        </td>
      )}
    </tr>
  );
}

export function InsightsScreen() {
  const preferences = usePreferences();
  const timezone = preferences.data?.timezone;
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const today = formatInTimeZone(now, timezone || "UTC", "yyyy-MM-dd");
  const meals = useMeals(
    { to: today, limit: 100 },
    { enabled: !!timezone, timezone },
  );
  const actions = useMealActions();
  const dates = timezone
    ? groupMeals(
        (meals.data?.pages.flatMap((page) => page.meals) ?? []).filter(
          (meal) => actions[meal.id]?.meal !== null,
        ),
        timezone,
      )
        .map((group) => group.date)
        .filter((date) => date <= today)
        .slice(0, 7)
    : [];
  const needsMore = !!timezone && dates.length < 7 && meals.hasNextPage;
  const { fetchNextPage } = meals;
  useEffect(() => {
    if (needsMore && !meals.isFetching && !meals.isError) void fetchNextPage();
  }, [needsMore, meals.isFetching, meals.isError, fetchNextPage]);
  const loading =
    preferences.isPending ||
    (!!timezone && (meals.isPending || (needsMore && !meals.isError)));
  return (
    <PageFrame
      title="Insights"
      description="A little perspective on the days you’ve logged."
      action={<HeaderLink href="/history">View history</HeaderLink>}
    >
      <section className="mt-8" aria-label="Recorded days">
        <h2 className="text-base font-semibold">Last 7 recorded days</h2>
        <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
          Days with saved meals, through today. Missing days aren’t counted as
          zero.
        </p>
        {timezone && (
          <p className="mt-2 text-xs text-muted-foreground">
            Dates follow {timezone.replaceAll("_", " ")}.
          </p>
        )}
        {preferences.isError && (
          <div role="alert" className="mt-5 text-sm">
            <p className="mb-3">
              {preferences.data
                ? "Showing your last saved time zone."
                : "Your time zone couldn’t load."}
            </p>
            <button
              className={action}
              disabled={preferences.isFetching}
              onClick={() => void preferences.refetch()}
            >
              {preferences.isFetching
                ? "Loading time zone…"
                : "Retry time zone"}
            </button>
          </div>
        )}
        {dates.length > 0 && (
          <table className="mt-6 w-full table-fixed text-sm">
            <caption className="sr-only">
              Calories and protein for the latest recorded days, newest first
            </caption>
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th scope="col" className="w-[42%] pb-3 text-left font-normal">
                  Date
                </th>
                <th scope="col" className="pb-3 text-right font-normal">
                  Calories <span className="block sm:inline">(kcal)</span>
                </th>
                <th scope="col" className="pb-3 text-right font-normal">
                  Protein
                </th>
              </tr>
            </thead>
            <tbody>
              {dates.map((date) => (
                <RecordedDay key={`${timezone}:${date}`} date={date} />
              ))}
            </tbody>
          </table>
        )}
        {loading && (
          <LoadingSkeleton
            label="Finding your recorded days…"
            kind="rows"
            rows={Math.max(1, 7 - dates.length)}
            className="mt-6"
          />
        )}
        {!!timezone && meals.isError && (
          <div role="alert" className="mt-5 text-sm">
            <p className="mb-3">
              {dates.length
                ? "Some recorded days couldn’t load. Your loaded days are still here."
                : "Your recorded days couldn’t load."}
            </p>
            <button
              className={action}
              disabled={meals.isFetching}
              onClick={() => {
                if (meals.isFetchNextPageError) void fetchNextPage();
                else void meals.refetch();
              }}
            >
              {meals.isFetching
                ? "Loading recorded days…"
                : "Retry recorded days"}
            </button>
          </div>
        )}
        {!loading &&
          !!timezone &&
          !meals.isError &&
          !meals.hasNextPage &&
          dates.length === 0 && (
            <EmptyPanel
              icon={ChartLine}
              title="Your first day starts with a meal"
              description="Save a meal in Chat to see its daily calories and protein here."
              action={<HeaderLink href="/chat">Log a meal</HeaderLink>}
            />
          )}
        {!loading && !meals.isError && dates.length > 0 && dates.length < 7 && (
          <p className="mt-4 text-xs text-muted-foreground">
            {dates.length} recorded {dates.length === 1 ? "day" : "days"} so
            far. More will appear as you log meals.
          </p>
        )}
        <p className="mt-8 border-t border-[var(--app-line)] pt-5 text-sm text-muted-foreground">
          Charts and trends are coming. For now, these are your saved daily
          totals.
        </p>
      </section>
    </PageFrame>
  );
}
